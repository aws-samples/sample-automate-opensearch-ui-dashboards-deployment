import * as cdk from 'aws-cdk-lib';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface OpenSearchDashboardStackProps extends cdk.StackProps {
  masterUserArn?: string;
  enableVpc?: string;
  idcInstanceArn?: string;
}

export class OpenSearchDashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: OpenSearchDashboardStackProps) {
    super(scope, id, props);

    const masterUserArn = props?.masterUserArn || `arn:aws:iam::<your account>:role/demo`;
    const domainName = 'data-source-demo';
    const appName = 'app-demo';
    const enableVpc = props?.enableVpc?.toLowerCase() === 'true';

    // Create VPC if enabled
    const vpc = enableVpc ? new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
    }) : undefined;

    // Step 1: Create IAM Role for Dashboard Lambda FIRST
    // This role ARN will be used in OpenSearch UI AppConfigs for admin access
    const dashboardRole = new iam.Role(this, 'DashboardLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for automated dashboard setup - creates workspaces and imports dashboards',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        OpenSearchAccess: new iam.PolicyDocument({
          statements: [
            // OpenSearch UI API access
            new iam.PolicyStatement({
              actions: ['opensearch:ApplicationAccessAll'],
              resources: ['*'] // Will be restricted to specific app after creation
            }),
            // OpenSearch Domain data access (for ingesting sample data)
            new iam.PolicyStatement({
              actions: [
                'es:ESHttpPost',
                'es:ESHttpPut',
                'es:ESHttpGet'
              ],
              resources: [`arn:aws:es:${this.region}:${this.account}:domain/${domainName}/*`]
            })
          ]
        })
      }
    });

    // Allow this role to be executed within a lambda in a VPC
    if (vpc) {
      dashboardRole.addManagedPolicy( iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));
    }

    // Create IAM Role for Identity Center Application Access (if IDC is enabled)
    const idcInstanceArn = props?.idcInstanceArn;
    const idcAccessRole = idcInstanceArn ? new iam.Role(this, 'IDCAccessRole', {
      roleName: `opensearch-ui-idc-role`,
      assumedBy: new iam.ServicePrincipal('application.opensearchservice.amazonaws.com'),
      description: 'Role for Identity Center to access OpenSearch',
      inlinePolicies: {
        IdentityStoreAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'identitystore:DescribeUser',
                'identitystore:ListGroupMembershipsForMember',
                'identitystore:DescribeGroup'
              ],
              resources: ['*'],
              conditions: {
                'ForAnyValue:StringEquals': {
                  'aws:CalledViaLast': 'es.amazonaws.com'
                }
              }
            }),
            new iam.PolicyStatement({
              actions: ['es:ESHttp*'],
              resources: ['*']
            }),
            new iam.PolicyStatement({
              actions: ['aoss:APIAccessAll'],
              resources: ['*']
            })
          ]
        })
      }
    }) : undefined;

    // Override trust policy to include both sts:AssumeRole and sts:SetContext
    if (idcAccessRole) {
      const cfnRole = idcAccessRole.node.defaultChild as iam.CfnRole;
      cfnRole.assumeRolePolicyDocument = {
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'application.opensearchservice.amazonaws.com'
            },
            Action: ['sts:AssumeRole', 'sts:SetContext']
          }
        ]
      };
    }

    // Create OpenSearch Security Group
    const openSearchSecurityGroup = vpc ? new ec2.SecurityGroup(this, 'OpenSearchSecurityGroup', {
      allowAllOutbound: true,
      description: 'Security Group for OpenSearch',
      vpc: vpc,
    }) : undefined;
    openSearchSecurityGroup?.addIngressRule(
      openSearchSecurityGroup,
      ec2.Port.tcp(443),
      'Allow inbound HTTPS traffic from itself',
    );

    // Step 2: Create OpenSearch Domain

    const opensearchDomain = new opensearch.Domain(this, 'OpenSearchDomain', {
      domainName: domainName,
      version: opensearch.EngineVersion.OPENSEARCH_2_11,
      
      // Capacity configuration - single node (no zone awareness, simpler for demo)
      capacity: {
        dataNodes: 1,
        dataNodeInstanceType: 'r6g.large.search',
        multiAzWithStandbyEnabled: false
      },
      
      // EBS configuration
      ebs: {
        enabled: true,
        volumeSize: 100,
        volumeType: ec2.EbsDeviceVolumeType.GP3
      },
      
      // Security configuration
      encryptionAtRest: {
        enabled: true
      },
      zoneAwareness: { enabled: false },
      nodeToNodeEncryption: true,
      enforceHttps: true,
      tlsSecurityPolicy: opensearch.TLSSecurityPolicy.TLS_1_2,
      
      // Access policies - allow Lambda role and admin user
      accessPolicies: [    
        // Admin role full access
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.ArnPrincipal(masterUserArn)],
          actions: ['es:*'],
          resources: [
            `arn:aws:es:${this.region}:${this.account}:domain/${domainName}`,
            `arn:aws:es:${this.region}:${this.account}:domain/${domainName}/*`,
          ],
        }),
      ],
      
      // VPC configuration
      ...(vpc && openSearchSecurityGroup && {
        vpc: vpc,
        vpcSubnets: [
          {
            subnets: [vpc.privateSubnets[0]], // Explicitly select only the first private subnet
          },
        ],
        securityGroups: [openSearchSecurityGroup],
      }),
      
      removalPolicy: cdk.RemovalPolicy.DESTROY // For demo purposes only
    });

    // Authorize OpenSearch UI service for VPC endpoint access
    if (vpc) {
      const authorizeOpenSearchUIVpcAccess = new cr.AwsCustomResource(this, 'AuthorizeOpenSearchUIVpcAccess', {
        onUpdate: {
          service: 'OpenSearch',
          action: 'authorizeVpcEndpointAccess',
          parameters: {
            DomainName: opensearchDomain.domainName,
            Service: 'application.opensearchservice.amazonaws.com',
          },
          physicalResourceId: cr.PhysicalResourceId.of(`${opensearchDomain.domainName}-VpcEndpointAccess`),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['es:AuthorizeVpcEndpointAccess'],
            resources: [opensearchDomain.domainArn],
          }),
        ]),
      });

      // Ensure domain is created before the custom resource
      authorizeOpenSearchUIVpcAccess.node.addDependency(opensearchDomain);
    }

    // Wait for domain to be ready
    // This avoids a race condition that would cause the error "DataSource data-source-demo is not ready"
    const domainReadyWaiter = new cr.AwsCustomResource(this, 'DomainReadyWaiter', {
      onUpdate: {
        service: 'OpenSearch',
        action: 'describeDomainHealth',
        parameters: {
          DomainName: opensearchDomain.domainName,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${opensearchDomain.domainName}-ready`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['es:DescribeDomainHealth'],
          resources: [opensearchDomain.domainArn],
        }),
      ]),
    });
    
    domainReadyWaiter.node.addDependency(opensearchDomain);

    // Step 3: Create OpenSearch UI Application
    // IMPORTANT: AppConfigs uses the Lambda role ARN for admin access
    const openSearchUI = new opensearch.CfnApplication(this, 'OpenSearchUI', {
      appConfigs: [
        {
          key: 'opensearchDashboards.dashboardAdmin.users',
          value: `["*"]` // Configuring global admin access for demo 
        },
        {
          key: 'opensearchDashboards.dashboardAdmin.groups',
          value: `["${dashboardRole.roleArn}"]` // Lambda role for automation
        }
      ],
      dataSources: [{
        dataSourceArn: opensearchDomain.domainArn,
        dataSourceDescription: 'Primary OpenSearch Domain'
      }],
      // Enable IDC if instanceArn is provided (supports hybrid IAM + IDC authentication)
      iamIdentityCenterOptions: idcInstanceArn && idcAccessRole ? {
        enabled: true,
        iamIdentityCenterInstanceArn: idcInstanceArn,
        iamRoleForIdentityCenterApplicationArn: idcAccessRole.roleArn
      } : {
        enabled: false
      },
      name: appName
    });

    // Wait for domain to be ready before creating UI application
    openSearchUI.node.addDependency(domainReadyWaiter);

    // Step 4: Create Lambda Function for Dashboard Setup
    const dashboardFn = new lambda.Function(this, 'DashboardSetup', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'dashboard_automation.handler',
      code: lambda.Code.fromAsset('../lambda', {
        bundling: {
          image: lambda.Runtime.PYTHON_3_11.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -r *.py /asset-output/'
          ]
        }
      }),
      timeout: cdk.Duration.minutes(5),
      role: dashboardRole,
      // Place the Lambda in a VPC
      ...(vpc && openSearchSecurityGroup && { 
        vpc: vpc, 
        securityGroups: [openSearchSecurityGroup] 
      }),
    });

    // Step 5: Create Custom Resource
    // Custom Resource Provider
    const provider = new cr.Provider(this, 'DashboardProvider', {
      onEventHandler: dashboardFn
    });

    // Construct OpenSearch UI endpoint from application name and ID
    // Format: application-{name}-{id}.{region}.opensearch.amazonaws.com
    const appId = openSearchUI.getAtt('Id').toString();
    const openSearchUIEndpoint = `application-${appName}-${appId}.${this.region}.opensearch.amazonaws.com`;

    // Custom Resource to trigger dashboard setup
    const dashboardSetup = new cdk.CustomResource(this, 'DashboardSetupResource', {
      serviceToken: provider.serviceToken,
      properties: {
        opensearchUIEndpoint: openSearchUIEndpoint,
        domainName: opensearchDomain.domainName,
        domainEndpoint: opensearchDomain.domainEndpoint,
        workspaceName: 'workspace-demo',
        region: cdk.Stack.of(this).region,
        // version: '9', // for develping, increase version to force Custom Resource updates
      }
    });

    // Ensure OpenSearch UI is created before custom resource
    dashboardSetup.node.addDependency(openSearchUI);

    // Output the OpenSearch UI endpoint
    new cdk.CfnOutput(this, 'OpenSearchUIEndpoint', {
      value: `https://${openSearchUIEndpoint}`,
      description: 'OpenSearch UI Application Endpoint'
    });

    new cdk.CfnOutput(this, 'OpenSearchDomainEndpoint', {
      value: opensearchDomain.domainEndpoint,
      description: 'OpenSearch Domain Endpoint'
    });

    new cdk.CfnOutput(this, 'WorkspaceId', {
      value: dashboardSetup.getAttString('WorkspaceId'),
      description: 'Created Workspace ID'
    });

    new cdk.CfnOutput(this, 'IDCEnabled', {
      value: idcInstanceArn ? 'Yes (Hybrid IAM + IDC)' : 'No (IAM only)',
      description: 'Identity Center Authentication Status'
    });

    if (idcInstanceArn && idcAccessRole) {
      new cdk.CfnOutput(this, 'IDCRoleArn', {
        value: idcAccessRole.roleArn,
        description: 'IAM Role ARN for Identity Center Application Access'
      });
    }
  }
}
