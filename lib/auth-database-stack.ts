import * as cdk from "aws-cdk-lib";
import {Construct} from "constructs";
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import {SecretValue,} from "aws-cdk-lib";
import {IpAddresses, SecurityGroup} from "aws-cdk-lib/aws-ec2";
import {allResources} from "aws-cdk-lib/assertions/lib/private/resources";

export class AuthDatabaseStackStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, 'auth-db-vpc', {
            natGateways:0
        })


        // 👇 create a security group for the EC2 instance
        const secGroup = new ec2.SecurityGroup(this, 'auth-db-sg', {
            vpc,
        });

        secGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(3306),
            'allow SSH connections from anywhere',
        );
        secGroup.addIngressRule(
            ec2.Peer.anyIpv6(),
            ec2.Port.tcp(3306),
            'allow SSH connections from anywhere',
        );
        secGroup.addIngressRule(
            secGroup,
            ec2.Port.allTraffic()
        )

        const instance = new rds.DatabaseInstance(this, "auth-instance", {
            instanceIdentifier:'auth-user',
            databaseName:'user',
            engine: rds.DatabaseInstanceEngine.mysql({
                version: rds.MysqlEngineVersion.VER_8_0_28,
            }),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.MICRO),
            vpc,
            vpcSubnets:{subnetType: ec2.SubnetType.PUBLIC},
            publiclyAccessible: true,
            credentials: rds.Credentials.fromPassword('admin',SecretValue.secretsManager('auth-db-pw')),
            securityGroups:[secGroup],
        })

        instance.connections.allowDefaultPortFromAnyIpv4()

        new cdk.CfnOutput(this, 'auth-db-Endpoint', {
            value: instance.instanceEndpoint.hostname,
        });
    }
}