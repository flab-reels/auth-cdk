import * as cdk from 'aws-cdk-lib';
import {
    aws_ecs_patterns,
    aws_elasticloadbalancingv2,
    aws_elasticloadbalancingv2_targets, CfnOutput,
    SecretValue
} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline'
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import {SecurityGroup} from 'aws-cdk-lib/aws-ec2'
import {ApplicationLoadBalancer, NetworkLoadBalancer, Protocol} from "aws-cdk-lib/aws-elasticloadbalancingv2"
import {LogGroup} from "aws-cdk-lib/aws-logs";
import {Effect, PolicyStatement, Role, ServicePrincipal} from "aws-cdk-lib/aws-iam";

export class AuthPipelineStack extends cdk.Stack {
    public readonly tagParameterContainerImage: ecs.TagParameterContainerImage;
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);


        const appEcrRepo = new ecr.Repository(this, 'auth-ecr-repository',{
            repositoryName:'auth-ecr-repository'
        });


        const appCodeDockerBuild = new codebuild.PipelineProject(this, 'auth-docker-build', {
            projectName: "auth-codebuild",
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2,
                privileged: true
            },
            environmentVariables: {
                REPOSITORY_URI: {
                    value: appEcrRepo.repositoryUri,
                },
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        "runtime-versions": {
                            java: 'corretto11',
                        },
                        commands: [

                            'echo Java version check',
                            'java -version',

                            'echo Logging in to Amazon ECR...',
                            '$(aws ecr get-login --region $AWS_DEFAULT_REGION --no-include-email)',

                            'IMAGE_TAG=${COMMIT_HASH:=latest}',
                        ]
                    },
                    build: {
                        commands: [
                            'echo Build started on `date`',
                            './gradlew bootBuildImage --imageName=$REPOSITORY_URI:$IMAGE_TAG',

                            'echo Pushing Docker Image',

                            'docker push $REPOSITORY_URI:$IMAGE_TAG',

                            'export imageTag=$IMAGE_TAG',
                            'echo imageTag=$IMAGE_TAG'
                        ],
                    },
                    post_build: {
                        commands: [
                            "echo creating imagedefinitions.json dynamically",

                            "printf '[{\"name\":\"" + 'auth-ecr-repository' + "\",\"imageUri\": \"" + appEcrRepo.repositoryUriForTag() + ":latest\"}]' > imagedefinitions.json",

                            "echo Build completed on `date`"
                        ]
                    },
                },
                env:{
                    'exported-variables': [
                        'imageTag',
                    ],
                },
                cache: {
                    paths: '/root/.gradle/**/*',
                },
                artifacts: {
                    files: [
                        "imagedefinitions.json"
                    ],
                },

            }),
        });

        appEcrRepo.grantPullPush(appCodeDockerBuild);
        // create the ContainerImage used for the ECS application Stack
        this.tagParameterContainerImage = new ecs.TagParameterContainerImage(appEcrRepo);



        const cdkCodeBuild = new codebuild.PipelineProject(this, 'CdkCodeBuildProject', {
            projectName: "auth-cdk-codebuild",
            environment: {
                buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
                privileged: true
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                phases: {
                    install: {
                        commands: [
                            'npm install',
                            "n 16.15.1",
                        ],
                    },
                    build: {
                        commands: [
                            // synthesize the CDK code for the ECS application Stack
                            'npx cdk synth --verbose',
                        ],
                    },
                },
                artifacts: {
                    // store the entire Cloud Assembly as the output artifact
                    'base-directory': 'cdk.out',
                    'files': '**/*',
                },
            }),
        });



        /** 파이프라인 세션 단계별로 구별 할수 있게 처리*/
        const appCodeSourceOutput = new codepipeline.Artifact();
        const cdkCodeSourceOutput = new codepipeline.Artifact();
        const cdkCodeBuildOutput = new codepipeline.Artifact();

        const appCodeBuildAction = new codepipeline_actions.CodeBuildAction({
            actionName: 'auth-docker-build-action',
            project: appCodeDockerBuild,
            input: appCodeSourceOutput,
        });

        const githubSourceAction = this.createAuthGithubSourceAction(appCodeSourceOutput)
        const cdkSourceAction = this.createCDKGithubSourceAction(cdkCodeSourceOutput)

        new codepipeline.Pipeline(this, 'auth-code-pipeline', {
            pipelineName:"auth-pipeline",

            stages: [
                {
                    stageName: 'Source',
                    actions: [
                        /** SPRING BOOT SERVICE*/
                        githubSourceAction,


                        /** CDK CODE STACK BUILD*/
                        cdkSourceAction
                    ],
                },
                {
                    stageName: 'Build',
                    actions: [
                        /** SPRING BOOT SERVICE*/
                        appCodeBuildAction,


                        /** CDK CODE STACK BUILD*/
                        new codepipeline_actions.CodeBuildAction({
                            actionName: 'CdkCodeBuildAndSynth',
                            project: cdkCodeBuild,
                            input: cdkCodeSourceOutput,
                            outputs: [cdkCodeBuildOutput],
                        }),
                    ]
                },
                {
                    stageName: 'Deploy',
                    actions: [
                        new codepipeline_actions.CloudFormationCreateUpdateStackAction({
                            actionName: 'CFN_Deploy',
                            stackName: 'EcsStackDeployedInPipeline',
                            // this name has to be the same name as used below in the CDK code for the application Stack
                            templatePath: cdkCodeBuildOutput.atPath('EcsPipelineStack.template.json'),
                            adminPermissions: true,
                            parameterOverrides: {
                                // read the tag pushed to the ECR repository from the CodePipeline Variable saved by the application build step,
                                // and pass it as the CloudFormation Parameter for the tag
                                [this.tagParameterContainerImage.tagParameterName]: appCodeBuildAction.variable('imageTag'),
                            },
                        }),
                    ]
                },
            ],
        });


    }

    public createAuthGithubSourceAction(sourceOutput: codepipeline.Artifact): codepipeline_actions.GitHubSourceAction {
        return new codepipeline_actions.GitHubSourceAction({
            actionName: 'auth-pipeline-github',
            owner: 'flab-reels',
            repo: 'auth',
            oauthToken: SecretValue.secretsManager('auth_demo_v6'),
            output: sourceOutput,
            branch: 'master', // default: 'master'
        });
    }

    public createCDKGithubSourceAction(sourceOutput: codepipeline.Artifact): codepipeline_actions.GitHubSourceAction {
        return new codepipeline_actions.GitHubSourceAction({
            actionName: 'auth-pipeline-cdk',
            owner: 'flab-reels',
            repo: 'auth-cdk',
            oauthToken: SecretValue.secretsManager('auth_demo_v6'),
            output: sourceOutput,
            branch: 'master', // default: 'master'
        });
    }






}

/**
 * 1. 위 파이프라인 스택이 끝나면 밑의 코드들은 CloudFormation 으로 돌리도록 설정함
 * 2. 위 파이프라인 스택에서 만든 ECR Tag를 가져와서 CloudFormation 에서 CDK DEPLOY를 실행하게 함
 * 3. 소스는 Github, CodeCommit 다 가능
 */

export interface EcsAppStackProps extends cdk.StackProps {
    readonly image: ecs.ContainerImage;
}


export class AuthEcsAppStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EcsAppStackProps) {
        super(scope, id, props);

        //1. Create VPC
        const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2 });

        //2. Creation of Execution Role for our task
        const execRole = new Role(this, 'auth-api-exec-role', {
            roleName: 'auth-api-role', assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com')
        })


        //4. Create the ECS fargate cluster
        const cluster = new ecs.Cluster(this, 'auth-cluster', { vpc, clusterName: "auth-cluster" });

        //5. Create a task definition for our cluster to invoke a task
        const taskDef = new ecs.FargateTaskDefinition(this, "auth-task", {
            family: 'auth-task',
            memoryLimitMiB: 512,
            cpu: 256,
            executionRole: execRole,
            taskRole: execRole
        });


        //7. Create container for the task definition from ECR image
        const container = taskDef.addContainer("auth-container", {
            containerName:"auth-container",
            image: props.image,
        });

        //8. Add port mappings to your container...Make sure you use TCP protocol for Network Load Balancer (NLB)
        container.addPortMappings({
            containerPort: 8080,
            hostPort: 8080,
            protocol: ecs.Protocol.TCP
        });

        //9. Create the NLB using the above VPC.
        const lb = new NetworkLoadBalancer(this, 'auth-nlb', {
            loadBalancerName: 'auth-nlb',
            vpc,
            internetFacing: false
        });

        //10. Add a listener on a particular port for the NLB
        const listener = lb.addListener('auth-listener', {
            port: 8080,
        });

        //11. Create your own security Group using VPC
        const secGroup = new SecurityGroup(this, 'auth-sg', {
            securityGroupName: "search-sg",
            vpc:vpc,
            allowAllOutbound:true
        });

        //12. Add IngressRule to access the docker image on 80 and 7070 ports
        secGroup.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(80), 'SSH frm anywhere');
        secGroup.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(8080), '');

        //13. Create Fargate Service from cluster, task definition and the security group
        const fargateService = new ecs.FargateService(this, 'auth-fg-service', {
            cluster,
            taskDefinition: taskDef,
            assignPublicIp: true,
            serviceName: "auth-svc",
            securityGroups:[secGroup]
        });

        //14. Add fargate service to the listener
        listener.addTargets('auth-tg', {
            targetGroupName: 'auth-tg',
            port: 8080,
            targets: [fargateService],
            deregistrationDelay: cdk.Duration.seconds(300)
        });

        new cdk.CfnOutput(this, 'ClusterARN: ', { value: cluster.clusterArn });
    }
}
