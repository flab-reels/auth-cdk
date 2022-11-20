import * as cdk from 'aws-cdk-lib';
import {aws_ecs_patterns, SecretValue} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import {Protocol} from 'aws-cdk-lib/aws-ecs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'

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
                            "n 16.15.1"
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

        const githubSourceAction = this.createAuthGithubSourceAction(appCodeSourceOutput);

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
                            templatePath: cdkCodeBuildOutput.atPath('EcsStackDeployedInPipeline.template.json'),
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


export interface EcsAppStackProps extends cdk.StackProps {
    readonly image: ecs.ContainerImage;
}

/**
 * This is the Stack containing a simple ECS Service that uses the provided ContainerImage.
 */
export class AuthEcsAppStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EcsAppStackProps) {
        super(scope, id, props);


        // const taskDefinition = new ecs.TaskDefinition(this, 'TaskDefinition', {
        //
        //     compatibility: ecs.Compatibility.FARGATE,
        //     cpu: '1024',
        //     memoryMiB: '512',
        // });
        // taskDefinition.addContainer('AppContainer', {
        //     containerName: "auth-container",
        //     image: props.image,
        //
        // });
        new aws_ecs_patterns.ApplicationLoadBalancedFargateService(this, 'EcsService', {
            serviceName:"auth-ecs-service",
            memoryLimitMiB: 1024,
            cpu: 512,
            cluster: new ecs.Cluster(this, 'Cluster', {
                vpc: new ec2.Vpc(this, 'Vpc', {
                    maxAzs: 1,
                }),
            }),
            taskImageOptions:{
                image:props.image,
                containerName: "auth-container",
                containerPort:8080
            }
        });





    }
}
