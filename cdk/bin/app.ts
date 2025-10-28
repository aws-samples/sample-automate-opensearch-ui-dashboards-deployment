#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { OpenSearchDashboardStack } from '../lib/dashboard-stack';

const app = new cdk.App();

new OpenSearchDashboardStack(app, 'OpenSearchDashboardAutomationStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-west-2'
  },
  description: 'Automated OpenSearch Dashboard Deployment with CDK',
  masterUserArn: app.node.tryGetContext('masterUserArn'),
  enableVpc: app.node.tryGetContext('enableVpc')
});
