import * as cdk from 'aws-cdk-lib';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface OpenSearchDashboardStackProps extends cdk.StackProps {
  masterUserArn?: string;
}

export class OpenSearchDashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: OpenSearchDashboardStackProps) {
    super(scope, id, props);

    // Use provided master user ARN or default to current execution role
    const masterUserArn = props?.masterUserArn || 
      `arn:aws:iam::<your account>:role/demo`;

    // Domain name used in multiple places
    const domainName = `data-source-demo`;

    // VPC to place the OpenSearch domain in
    // If you want to enable a VPC, uncomment this part
    // const vpc = new ec2.Vpc(this, 'Vpc', {
    //   ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
    // });

    // Step 1: Create IAM Role for Dashboard Lambda FIRST
    // This role ARN will be used in OpenSearch UI AppConfigs for admin access
    const dashboardRole = new iam.Role(this, 'DashboardLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for automated dashboard setup - creates workspaces and imports dashboards',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        // Allow this role to be executed within a lambda in a VPC
        // If you want to enable a VPC, uncomment this part
        // iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
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

    // Create OpenSearch Security Group
    // If you want to enable a VPC, uncomment this part
    // const openSearchSecurityGroup = new ec2.SecurityGroup(this, 'OpenSearchSecurityGroup', {
    //   allowAllOutbound: true,
    //   description: 'Security Group for OpenSearch',
    //   vpc: vpc,
    // });
    // openSearchSecurityGroup.addIngressRule(
    //   openSearchSecurityGroup,
    //   ec2.Port.tcp(443),
    //   'Allow inbound HTTPS traffic from itself',
    // );

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
      // If you want to enable a VPC, uncomment this part
      // vpc: vpc,
      // vpcSubnets: [
      //   {
      //     subnets: [vpc.privateSubnets[0]], // Explicitly select only the first private subnet
      //   },
      // ],
      // securityGroups: [openSearchSecurityGroup],
      
      removalPolicy: cdk.RemovalPolicy.DESTROY // For demo purposes only
    });

    // Authorize OpenSearch UI service for VPC endpoint access
    // If you want to enable a VPC, uncomment this part
    // const authorizeOpenSearchUIVpcAccess = new cr.AwsCustomResource(this, 'AuthorizeOpenSearchUIVpcAccess', {
    //   onUpdate: {
    //     service: 'OpenSearch',
    //     action: 'authorizeVpcEndpointAccess',
    //     parameters: {
    //       DomainName: opensearchDomain.domainName,
    //       Service: 'application.opensearchservice.amazonaws.com',
    //     },
    //     physicalResourceId: cr.PhysicalResourceId.of(`${opensearchDomain.domainName}-VpcEndpointAccess`),
    //   },
    //   policy: cr.AwsCustomResourcePolicy.fromStatements([
    //     new iam.PolicyStatement({
    //       actions: ['es:AuthorizeVpcEndpointAccess'],
    //       resources: [opensearchDomain.domainArn],
    //     }),
    //   ]),
    // });

    // Ensure domain is created before the custom resource
    // If you want to enable a VPC, uncomment this part
    // authorizeOpenSearchUIVpcAccess.node.addDependency(opensearchDomain);

    // Step 3: Create OpenSearch UI Application
    // IMPORTANT: AppConfigs uses the Lambda role ARN for admin access
    const appName = `app-demo`;
    const openSearchUI = new opensearch.CfnApplication(this, 'OpenSearchUI', {
      appConfigs: [
        {
          key: 'opensearchDashboards.dashboardAdmin.users',
          value: `["${masterUserArn}"]` // Human users
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
      iamIdentityCenterOptions: {
        enabled: false
      },
      name: appName
    });

    // Ensure domain is created before UI application
    openSearchUI.node.addDependency(opensearchDomain);

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
      // If you want to enable a VPC, uncomment this part
      // vpc: vpc,
      // securityGroups: [openSearchSecurityGroup]
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
        // version: '8', for develping, increase version to force Custom Resource updates
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
  }
}
