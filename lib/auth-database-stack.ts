import * as cdk from "aws-cdk-lib";
import {Construct} from "constructs";
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import {SecretValue} from "aws-cdk-lib";
import {SecurityGroup} from "aws-cdk-lib/aws-ec2";

export class AuthDatabaseStackStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'auth-db-vpc', {
            vpcName:"auth-db-vpc",
        })
        const secGroup = new SecurityGroup(this, 'auth-sg', {
            securityGroupName: "auth-sg",
            vpc:vpc,
            allowAllOutbound:true
        });
        secGroup.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(80), 'SSH frm anywhere');
        secGroup.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(8080), '');

        const instance = new rds.DatabaseInstance(this, "auth-instance", {
            databaseName:'user',
            engine: rds.DatabaseInstanceEngine.mysql({
                version: rds.MysqlEngineVersion.VER_8_0_28,
            }),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.MICRO),
            vpc,
            publiclyAccessible: true,
            credentials: rds.Credentials.fromPassword('admin',SecretValue.secretsManager('auth-db-pw')),
            securityGroups:[secGroup],

        })
        new cdk.CfnOutput(this, 'auth-db-Endpoint', {
            value: instance.instanceEndpoint.hostname,
        });
    }
}