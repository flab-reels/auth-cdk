#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {AuthEcsAppStack, AuthPipelineStack} from "../lib/auth-pipeline-stack";
import {AuthDatabaseStackStack} from "../lib/auth-database-stack";

const app = new cdk.App();
const authPipelineStack = new AuthPipelineStack(app, 'AuthPipelineStack')
new AuthEcsAppStack(app, 'AuthEcsStackDeployedInPipeline', {
    image: authPipelineStack.tagParameterContainerImage,
});
new AuthDatabaseStackStack(app, 'AuthDataBaseStack',{
    env:{
        account: '788675236515',
        region:'ap-northeast-2'
    }})