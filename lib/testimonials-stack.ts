import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export class TestimonialsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bucketName = this.node.tryGetContext("bucketName") ?? "jta-data-bucket";
    const bucketPrefix = this.node.tryGetContext("bucketPrefix") ?? "JTA data set/";
    const bedrockModelId =
      this.node.tryGetContext("bedrockModelId") ??
      "anthropic.claude-3-5-sonnet-20240620-v1:0";
    const privateClientCidrs = this.readPrivateClientCidrs();

    const vpc = new ec2.Vpc(this, "TestimonialsVpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/16"),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED
        }
      ]
    });

    vpc.addGatewayEndpoint("S3GatewayEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3
    });

    const endpointSecurityGroup = new ec2.SecurityGroup(this, "EndpointSecurityGroup", {
      vpc,
      allowAllOutbound: true,
      description: "Allows isolated Lambdas to reach private AWS service endpoints."
    });
    const executeApiSecurityGroup = new ec2.SecurityGroup(this, "ExecuteApiSecurityGroup", {
      vpc,
      allowAllOutbound: true,
      description: "Allows VPN/private-network clients to reach the private app endpoint."
    });

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, "LambdaSecurityGroup", {
      vpc,
      allowAllOutbound: true,
      description: "Security group for private testimonial application Lambdas."
    });

    endpointSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(443),
      "Allow Lambda HTTPS traffic to interface endpoints"
    );
    for (const cidr of privateClientCidrs) {
      executeApiSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(443),
        "Allow configured private clients to call execute-api"
      );
    }

    vpc.addInterfaceEndpoint("LogsEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
      securityGroups: [endpointSecurityGroup]
    });
    vpc.addInterfaceEndpoint("SecretsManagerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      privateDnsEnabled: true,
      securityGroups: [endpointSecurityGroup]
    });
    const executeApiEndpoint = vpc.addInterfaceEndpoint("ExecuteApiEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      privateDnsEnabled: true,
      securityGroups: [executeApiSecurityGroup]
    });
    vpc.addInterfaceEndpoint("BedrockRuntimeEndpoint", {
      service: new ec2.InterfaceVpcEndpointAwsService("bedrock-runtime"),
      privateDnsEnabled: true,
      securityGroups: [endpointSecurityGroup]
    });

    const authSecret = new secretsmanager.Secret(this, "AuthCredentialsSecret", {
      description:
        "Private app username/password credentials. Rotate or replace before production use.",
      generateSecretString: {
        excludePunctuation: true,
        generateStringKey: "adminPassword",
        passwordLength: 24,
        secretStringTemplate: JSON.stringify({ adminUsername: "admin" })
      }
    });
    const sessionSecret = new secretsmanager.Secret(this, "SessionSigningSecret", {
      description: "HMAC signing secret for private app session cookies.",
      generateSecretString: {
        passwordLength: 64
      }
    });
    const applicationLogGroup = new logs.LogGroup(this, "ApplicationHandlerLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const applicationHandler = new nodeLambda.NodejsFunction(this, "ApplicationHandler", {
      architecture: lambda.Architecture.ARM_64,
      bundling: {
        commandHooks: {
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [`cp -R ${inputDir}/dist/frontend ${outputDir}/public`];
          },
          beforeBundling(inputDir: string): string[] {
            return [`cd ${inputDir} && npm run build:frontend`];
          },
          beforeInstall(): string[] {
            return [];
          }
        },
        minify: true,
        sourceMap: true
      },
      depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
      entry: path.join(__dirname, "..", "src", "backend", "app.ts"),
      environment: {
        AUTH_SECRET_ARN: authSecret.secretArn,
        BEDROCK_MODEL_ID: bedrockModelId,
        BUCKET_NAME: bucketName,
        BUCKET_PREFIX: bucketPrefix,
        MAX_CONTEXT_CHARS: "160000",
        SESSION_SECRET_ARN: sessionSecret.secretArn
      },
      logGroup: applicationLogGroup,
      memorySize: 1536,
      runtime: lambda.Runtime.NODEJS_20_X,
      securityGroups: [lambdaSecurityGroup],
      timeout: Duration.minutes(2),
      tracing: lambda.Tracing.ACTIVE,
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED
      }
    });

    authSecret.grantRead(applicationHandler);
    sessionSecret.grantRead(applicationHandler);

    applicationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        conditions: {
          StringLike: {
            "s3:prefix": [`${bucketPrefix}*`]
          }
        },
        resources: [`arn:${cdk.Aws.PARTITION}:s3:::${bucketName}`]
      })
    );
    applicationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`arn:${cdk.Aws.PARTITION}:s3:::${bucketName}/${bucketPrefix}*`]
      })
    );
    applicationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"]
      })
    );

    const api = new apigateway.RestApi(this, "PrivateTestimonialsApi", {
      cloudWatchRole: false,
      deployOptions: {
        stageName: "prod",
        tracingEnabled: true
      },
      description: "Private API for the ADF testimonial generator.",
      endpointConfiguration: {
        types: [apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [executeApiEndpoint]
      },
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ["execute-api:Invoke"],
            conditions: {
              StringEquals: {
                "aws:SourceVpce": executeApiEndpoint.vpcEndpointId
              }
            },
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            resources: ["execute-api:/*"]
          })
        ]
      })
    });

    const integration = new apigateway.LambdaIntegration(applicationHandler, {
      proxy: true
    });
    api.root.addMethod("ANY", integration);
    api.root.addResource("{proxy+}").addMethod("ANY", integration);

    const existingBucket = s3.Bucket.fromBucketName(this, "ExistingDataBucket", bucketName);
    existingBucket.grantRead(applicationHandler, `${bucketPrefix}*`);

    new cdk.CfnOutput(this, "PrivateApiUrl", {
      value: api.url,
      description: "Private API URL, reachable through the execute-api VPC endpoint."
    });
    new cdk.CfnOutput(this, "ExecuteApiVpcEndpointId", {
      value: executeApiEndpoint.vpcEndpointId,
      description: "VPC endpoint that private clients must use to access the app."
    });
    new cdk.CfnOutput(this, "InitialAdminCredentialsSecretArn", {
      value: authSecret.secretArn,
      description: "Secret containing the generated admin username and password."
    });
  }

  private readPrivateClientCidrs(): string[] {
    const configuredCidrs = this.node.tryGetContext("privateClientCidrs");
    if (!configuredCidrs) {
      return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
    }

    const cidrs = Array.isArray(configuredCidrs)
      ? configuredCidrs
      : this.parsePrivateClientCidrs(configuredCidrs);

    if (cidrs.length === 0) {
      throw new Error("privateClientCidrs must include at least one CIDR");
    }

    return cidrs.map((cidr) => {
      if (typeof cidr !== "string") {
        throw new Error("Every privateClientCidrs entry must be a CIDR string");
      }
      return cidr;
    });
  }

  private parsePrivateClientCidrs(value: unknown): unknown[] {
    if (typeof value !== "string") {
      throw new Error("privateClientCidrs must be an array or string");
    }

    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("privateClientCidrs JSON must be an array");
      }
      return parsed;
    }

    return trimmed
      .split(",")
      .map((cidr) => cidr.trim())
      .filter(Boolean);
  }
}
