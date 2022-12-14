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
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'

export class AuthPipelineStack extends cdk.Stack {
    public readonly tagParameterContainerImage: ecs.TagParameterContainerImage;
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);


        const appEcrRepo = new ecr.Repository(this, 'auth-ecr-repository',{
            repositoryName:'auth-repository',

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



        /** ??????????????? ?????? ???????????? ?????? ?????? ?????? ??????*/
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
            oauthToken: SecretValue.secretsManager('github_source_accesskey'),
            output: sourceOutput,
            branch: 'master', // default: 'master'
        });
    }

    public createCDKGithubSourceAction(sourceOutput: codepipeline.Artifact): codepipeline_actions.GitHubSourceAction {
        return new codepipeline_actions.GitHubSourceAction({
            actionName: 'auth-pipeline-cdk',
            owner: 'flab-reels',
            repo: 'auth-cdk',
            oauthToken: SecretValue.secretsManager('github_source_accesskey'),
            output: sourceOutput,
            branch: 'master', // default: 'master'
        });
    }






}

/**
 * 1. ??? ??????????????? ????????? ????????? ?????? ???????????? CloudFormation ?????? ???????????? ?????????
 * 2. ??? ??????????????? ???????????? ?????? ECR Tag??? ???????????? CloudFormation ?????? CDK DEPLOY??? ???????????? ???
 * 3. ????????? Github, CodeCommit ??? ??????
 */

export interface EcsAppStackProps extends cdk.StackProps {
    readonly image: ecs.ContainerImage;
}


export class AuthEcsAppStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: EcsAppStackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, "auth-vpc", {
            vpcName:"auth-vpc",
            maxAzs: 3, // Default is all AZs in region
            natGateways:1
        });


        const cluster = new ecs.Cluster(this, 'Cluster', {
            vpc,
            clusterName:"auth-cluster"
        })
        const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'AuthFargateDefinition', {
            memoryLimitMiB: 1024,
            cpu: 512,

        });
        const container = fargateTaskDefinition.addContainer("AuthServiceContainer", {
            // Use an image from Amazon ECR
            image: props.image,
            /** Spring Boot Application.yml
             * - ???????????????, Secret?????? ?????? ??? ??????. ??????????????? ??????????????? ????????? Github??? ????????? ????????? ????????? ?????? ??? ??? ??????.
             *
             * - ????????? ?????? Application.yml ??????
             *   datasource:
             *     url: ${databaseUrl}
             *     username: ${databaseUser}
             *     password: ${databasePassword}
             *
             * - ?????? ?????? Scope??? ??????????????? ?????? ????????? ?????? ????????? ????????? ??? ?????? ??????.
             */
            environment:{
                'databaseUrl': 'jdbc:mysql://auth-user.c8rfpvihe7gd.ap-northeast-2.rds.amazonaws.com:3306/auth?serverTimezone=Asia/Seoul&characterEncoding=UTF-8',
                'databaseUser': 'admin',
                'facebookClientId':'1175640313043216',
                'naverClientId':'UbTn1oyNc2ddhpxcUdKQ',
                'googleClientId':'354098202531-cm8qe3s9g2jcjjg5naa3afdc4fv7fqh7.apps.googleusercontent.com',
            },
            secrets : {
                'databasePassword' : ecs.Secret.fromSecretsManager(
                    new secretsmanager.Secret(this,'auth-db-secret',{
                    secretStringValue:SecretValue.secretsManager('auth-db-pw')
                })
                ),
                'googleSecret': ecs.Secret.fromSecretsManager(
                    new secretsmanager.Secret(this,'google-secret',{
                    secretStringValue:SecretValue.secretsManager('google_auth')
                })
                ),
                'naverSecret': ecs.Secret.fromSecretsManager(
                    new secretsmanager.Secret(this,'naver-secret',{
                        secretStringValue:SecretValue.secretsManager('naver_auth')
                    })
                ),
                'facebookSecret': ecs.Secret.fromSecretsManager(
                    new secretsmanager.Secret(this,'facebook-secret',{
                    secretStringValue:SecretValue.secretsManager('facebook_auth')
                })
                ),
            }

        });
        container.addPortMappings({
            containerPort: 8080,
            hostPort: 8080

        });



        const secGroup = new SecurityGroup(this, 'auth-sg', {
            allowAllOutbound:true,
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
            securityGroups: [secGroup],
            circuitBreaker:{rollback:true},
            assignPublicIp:true,

        });

        const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Auth-alb',{
            vpc,
            internetFacing:true,
            // idleTimeout:Duration.seconds(300),

        })

        const listener = loadBalancer.addListener('Auth-listener',{
            port:80,
            protocol:elbv2.ApplicationProtocol.HTTP,


        })
        listener.addTargets('Auth-target',{
            port:80,
            targets:[service],
            healthCheck:{
                path: "/actuator/health"
            }
        })

        secGroup.connections.allowFrom(
            loadBalancer,
            ec2.Port.allTcp()
        )
    }
}
