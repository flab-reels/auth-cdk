import * as cdk from 'aws-cdk-lib';
import {aws_ecs_patterns, aws_elasticloadbalancingv2, Duration, SecretValue} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline'
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions'
import * as codebuild from 'aws-cdk-lib/aws-codebuild'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import {Protocol} from 'aws-cdk-lib/aws-ecs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import {IpAddresses, SecurityGroup} from 'aws-cdk-lib/aws-ec2'

export class AuthPipelineStack extends cdk.Stack {
    public readonly tagParameterContainerImage: ecs.TagParameterContainerImage;
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);


        const appEcrRepo = new ecr.Repository(this, 'auth-ecr-repository',{
            repositoryName:'auth-repository',
            removalPolicy: cdk.RemovalPolicy.DESTROY
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

                        ]
                    },
                    build: {
                        commands: [
                            'echo Build started on `date`',
                            './gradlew bootBuildImage --imageName=$REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION',

                            'echo Pushing Docker Image',
                            'docker push $REPOSITORY_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION',
                            'export imageTag=$CODEBUILD_RESOLVED_SOURCE_VERSION',
                            'echo imageTag=$CODEBUILD_RESOLVED_SOURCE_VERSION'
                        ],
                    },
                    post_build: {
                        commands: [
                            // "echo creating imagedefinitions.json dynamically",

                            "printf '[{\"name\":\"" + 'auth-repository' + "\",\"imageUri\": \"" + appEcrRepo.repositoryUriForTag() + "${CODEBUILD_RESOLVED_SOURCE_VERSION}`\"}]' > imagedefinitions.json",

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
                            'npm install -g aws-cdk',
                            "n 16.15.1",
                        ],
                    },
                    build: {
                        commands: [
                            // synthesize the CDK code for the ECS application Stack
                            // 'npx cdk --version',
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
            // artifactBucket: new s3.Bucket(this, 'ArtifactBucket', {
            //     bucketName:'auth-cdk-bucket',
            //     removalPolicy: cdk.RemovalPolicy.DESTROY,
            // }),
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
                            actionName: 'Auth_CloudFormation_CodeDeploy',
                            stackName: 'AuthEcsStackDeployedInPipeline',
                            // this name has to be the same name as used below in the CDK code for the application Stack
                            templatePath: cdkCodeBuildOutput.atPath('AuthEcsStackDeployedInPipeline.template.json'),
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
            oauthToken: SecretValue.secretsManager('auth-github'),
            output: sourceOutput,
            branch: 'master', // default: 'master'
        });
    }

    public createCDKGithubSourceAction(sourceOutput: codepipeline.Artifact): codepipeline_actions.GitHubSourceAction {
        return new codepipeline_actions.GitHubSourceAction({
            actionName: 'auth-pipeline-cdk',
            owner: 'flab-reels',
            repo: 'auth-cdk',
            oauthToken: SecretValue.secretsManager('auth-github'),
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

        const vpc = new ec2.Vpc(this, "auth-vpc", {
            vpcName:"auth-vpc",
            maxAzs: 3 // Default is all AZs in region
        });


        const cluster = new ecs.Cluster(this, 'Cluster', {
            vpc,
            clusterName:"auth-cluster"
        })
        const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'AuthFargateDefinition', {
            memoryLimitMiB: 512,
            cpu: 256,

        });
        const container = fargateTaskDefinition.addContainer("AuthServiceContainer", {
            // Use an image from Amazon ECR
            image: props.image,
            /** Spring Boot Application.yml
             * - 환경변수와, Secret값을 넣을 수 있다. 보안상으로 이런식으로 넣으면 Github에 올려도 충분히 보안을 형성 할 수 있다.
             *
             * - 스프링 부트 Application.yml 예시
             *   datasource:
             *     url: ${databaseUrl}
             *     username: ${databaseUser}
             *     password: ${databasePassword}
             *
             * - 위와 같이 Scope를 설정해주면 값이 대입이 되어 보안을 유지할 수 있게 된다.
             */
            environment:{
                'databaseUrl': 'jdbc:mysql://auth-user.cj8dzd5oyawf.ap-northeast-2.rds.amazonaws.com:3306/user?serverTimezone=Asia/Seoul&characterEncoding=UTF-8',
                'databaseUser': 'admin',
            },
            secrets : {
                'databasePassword' : ecs.Secret.fromSecretsManager(
                    new secretsmanager.Secret(this,'auth-db-secret',{
                    secretStringValue:SecretValue.secretsManager('auth-db-pw')
                })
                ),
                'googleSecret': ecs.Secret.fromSecretsManager(
                    new secretsmanager.Secret(this,'google-secret',{
                    secretStringValue:SecretValue.secretsManager('google_reels')
                })
                ),
                'naverSecret': ecs.Secret.fromSecretsManager(
                    new secretsmanager.Secret(this,'naver-secret',{
                        secretStringValue:SecretValue.secretsManager('naver_reels')
                    })
                ),
                'facebookSecret': ecs.Secret.fromSecretsManager(
                    new secretsmanager.Secret(this,'facebook-secret',{
                    secretStringValue:SecretValue.secretsManager('facebook_reels')
                })
                ),
            }

        });
        container.addPortMappings({
            containerPort: 80,
            hostPort: 80

        });



        const secGroup = new SecurityGroup(this, 'auth-sg', {
            securityGroupName: "auth-sg",
            vpc:vpc,
        });

        secGroup.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(80), 'SSH frm anywhere');
        secGroup.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(8080), '');
        // secGroup.addIngressRule(secGroup, ec2.Port.allTraffic))
        const service = new ecs.FargateService(this, 'Service', {
            cluster,
            taskDefinition: fargateTaskDefinition,
            desiredCount: 1,
            assignPublicIp: true,
            securityGroups: [secGroup],

        });



    }
}
