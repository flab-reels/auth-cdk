#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {AuthEcsAppStack, AuthPipelineStack} from "../lib/auth-pipeline-stack";

const app = new cdk.App();
const authPipelineStack = new AuthPipelineStack(app, 'EcsPipelineStack');

new AuthEcsAppStack(app, 'EcsStackDeployedInPipeline', {
    image: authPipelineStack.tagParameterContainerImage,
});
