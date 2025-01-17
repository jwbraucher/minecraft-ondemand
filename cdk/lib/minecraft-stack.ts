import * as path from 'path';
import {
  Stack,
  StackProps,
  aws_ec2 as ec2,
  aws_efs as efs,
  aws_iam as iam,
  aws_ecs as ecs,
  aws_logs as logs,
  aws_sns as sns,
  RemovalPolicy,
  Arn,
  ArnFormat,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { constants } from './constants';
import { SSMParameterReader } from './ssm-parameter-reader';
import { StackConfig, MinecraftServerDef } from './types';
import { getMinecraftServerConfig, isDockerInstalled } from './util';

interface MinecraftStackProps extends StackProps {
  config: Readonly<StackConfig>;
}

export class MinecraftStack extends Stack {
  constructor(scope: Construct, id: string, props: MinecraftStackProps) {
    super(scope, id, props);

    const { config } = props;

    const vpc = config.vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: config.vpcId })
      : new ec2.Vpc(this, 'Vpc', {
          maxAzs: 3,
          natGateways: 0,
        });

    const fileSystem = new efs.FileSystem(this, 'FileSystem', {
      vpc,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    const accessPoint = new efs.AccessPoint(this, 'AccessPoint', {
      fileSystem,
      path: '/minecraft',
      posixUser: {
        uid: '1000',
        gid: '1000',
      },
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '0755',
      },
    });

    const efsReadWriteDataPolicy = new iam.Policy(this, 'DataRWPolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowReadWriteOnEFS',
          effect: iam.Effect.ALLOW,
          actions: [
            'elasticfilesystem:ClientMount',
            'elasticfilesystem:ClientWrite',
            'elasticfilesystem:DescribeFileSystems',
          ],
          resources: [fileSystem.fileSystemArn],
          conditions: {
            StringEquals: {
              'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn,
            },
          },
        }),
      ],
    });

    const ecsTaskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Minecraft ECS task role',
    });

    efsReadWriteDataPolicy.attachToRole(ecsTaskRole);

    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: constants.CLUSTER_NAME,
      vpc,
      containerInsights: false, // TODO: Add config for container insights
      enableFargateCapacityProviders: true,
    });

    const serviceSecurityGroup = new ec2.SecurityGroup(
      this,
      'ServiceSecurityGroup',
      {
        vpc,
        description: 'Security group for Minecraft on-demand',
      }
    );

    const hostedZoneId = new SSMParameterReader(
      this,
      'Route53HostedZoneIdReader',
      {
        parameterName: constants.HOSTED_ZONE_SSM_PARAMETER,
        region: constants.DOMAIN_STACK_REGION,
      }
    ).getParameterValue();

    let snsTopicArn = '';
    /* Create SNS Topic if SNS_EMAIL is provided */
    if (config.snsEmailAddress) {
      const snsTopic = new sns.Topic(this, 'ServerSnsTopic', {
        displayName: 'Minecraft Server Notifications',
      });

      snsTopic.grantPublish(ecsTaskRole);

      const emailSubscription = new sns.Subscription(
        this,
        'EmailSubscription',
        {
          protocol: sns.SubscriptionProtocol.EMAIL,
          topic: snsTopic,
          endpoint: config.snsEmailAddress,
        }
      );
      snsTopicArn = snsTopic.topicArn;
    }

    const efsMaintenanceInstanceRole = new iam.Role(this, 'EFSMaintenanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Minecraft EC2 instance role',
    });

    const ssmManagedInstanceCorePolicy = new iam.Policy(this, 'SSMManagedInstanceCorePolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'AllowSSMManagedInstance',
          effect: iam.Effect.ALLOW,
          actions: [
            "ssm:DescribeAssociation",
            "ssm:GetDeployablePatchSnapshotForInstance",
            "ssm:GetDocument",
            "ssm:DescribeDocument",
            "ssm:GetManifest",
            "ssm:GetParameter",
            "ssm:GetParameters",
            "ssm:ListAssociations",
            "ssm:ListInstanceAssociations",
            "ssm:PutInventory",
            "ssm:PutComplianceItems",
            "ssm:PutConfigurePackageResult",
            "ssm:UpdateAssociationStatus",
            "ssm:UpdateInstanceAssociationStatus",
            "ssm:UpdateInstanceInformation",
            "ssmmessages:CreateControlChannel",
            "ssmmessages:CreateDataChannel",
            "ssmmessages:OpenControlChannel",
            "ssmmessages:OpenDataChannel",
            "ec2messages:AcknowledgeMessage",
            "ec2messages:DeleteMessage",
            "ec2messages:FailMessage",
            "ec2messages:GetEndpoint",
            "ec2messages:GetMessages",
            "ec2messages:SendReply"
          ],
          resources: ['*']
        }),
      ],
    });
    ssmManagedInstanceCorePolicy.attachToRole(efsMaintenanceInstanceRole);
    efsReadWriteDataPolicy.attachToRole(efsMaintenanceInstanceRole);

    const efsMaintenanceSecurityGroup = new ec2.SecurityGroup(
      this,
      'EfsMaintenanceSecurityGroup',
      {
        vpc,
        description: 'Security group for Minecraft on-demand EFS Maintenance Instances',
      }
    );

    /* Allow access to EFS from Fargate service security group */
    fileSystem.connections.allowDefaultPortFrom(
      efsMaintenanceSecurityGroup
    );

    const efsMaintenanceLaunchTemplate = new ec2.LaunchTemplate(this, 'EFSMaintenanceLaunchTemplate', {
      userData: ec2.UserData.custom(`#cloud-config
package_update: true
package_upgrade: true
runcmd:
- yum install -y amazon-efs-utils
- apt-get -y install amazon-efs-utils
- yum install -y nfs-utils
- apt-get -y install nfs-common
- file_system_id_1=${fileSystem.fileSystemId}
- efs_mount_point_1=/mnt/efs/fs1
- mkdir -p "\${efs_mount_point_1}"
- test -f "/sbin/mount.efs" && printf "\\n\${file_system_id_1}:/ \${efs_mount_point_1} efs iam,tls,_netdev\\n" >> /etc/fstab || printf "\\n\${file_system_id_1}.efs.${config.serverRegion}.amazonaws.com:/ \${efs_mount_point_1} nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0\\n" >> /etc/fstab
- test -f "/sbin/mount.efs" && grep -ozP 'client-info]\\nsource' '/etc/amazon/efs/efs-utils.conf'; if [[ $? == 1 ]]; then printf "\\n[client-info]\\nsource=liw\\n" >> /etc/amazon/efs/efs-utils.conf; fi;
- retryCnt=15; waitTime=30; while true; do mount -a -t efs,nfs4 defaults; if [ $? = 0 ] || [ $retryCnt -lt 1 ]; then echo File system mounted successfully; break; fi; echo File system not available, retrying to mount.; ((retryCnt--)); sleep $waitTime; done;
`),
      role: efsMaintenanceInstanceRole,
      spotOptions: {
        interruptionBehavior: ec2.SpotInstanceInterruption.TERMINATE,
        requestType: ec2.SpotRequestType.ONE_TIME,
      },
      securityGroup: efsMaintenanceSecurityGroup,
      instanceInitiatedShutdownBehavior: ec2.InstanceInitiatedShutdownBehavior.TERMINATE,
    });

    /* The remaining statements are exectued for each Minecraft server in the config */
    Array.from(Object.keys(config.minecraftServerDefs)).forEach(key => {
      const thisMinecraftServerDef: MinecraftServerDef = config.minecraftServerDefs[key]

      const minecraftServerConfig = getMinecraftServerConfig(
        config.minecraftEdition
      );

      serviceSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        minecraftServerConfig.ingressRulePort,
        `Minecraft-Server-Ingress-${minecraftServerConfig.ingressRulePort}`,
      );

      const taskDefinition = new ecs.FargateTaskDefinition(
        this,
        'TaskDefinition-' + key,
        {
          taskRole: ecsTaskRole,
          memoryLimitMiB: thisMinecraftServerDef.memory,
          cpu: thisMinecraftServerDef.cpu,
          volumes: [
            {
              name: constants.ECS_VOLUME_NAME,
              efsVolumeConfiguration: {
                fileSystemId: fileSystem.fileSystemId,
                transitEncryption: 'ENABLED',
                authorizationConfig: {
                  accessPointId: accessPoint.accessPointId,
                  iam: 'ENABLED',
                },
              },
            },
          ],
        }
      );

      const minecraftServerContainer = new ecs.ContainerDefinition(
        this,
        'ServerContainer-' + key,
        {
          containerName: constants.MC_SERVER_CONTAINER_NAME + '-' + key,
          image: ecs.ContainerImage.fromRegistry(minecraftServerConfig.image),
          portMappings: [
            {
              containerPort: minecraftServerConfig.port,
              hostPort: minecraftServerConfig.port,
              protocol: minecraftServerConfig.protocol,
            },
          ],
          environment: thisMinecraftServerDef.containerEnv,
          entryPoint: [ '/minecraft/minecraft.sh' ],
          essential: true,
          pseudoTerminal: true,
          taskDefinition,
          logging: config.debug
            ? new ecs.AwsLogDriver({
                logRetention: logs.RetentionDays.THREE_DAYS,
                streamPrefix: constants.MC_SERVER_CONTAINER_NAME,
              })
            : undefined,
        }
      );

      minecraftServerContainer.addMountPoints({
        containerPath: '/minecraft',
        sourceVolume: constants.ECS_VOLUME_NAME,
        readOnly: false,
      });

      const minecraftServerService = new ecs.FargateService(
        this,
        'FargateService-' + key,
        {
          cluster,
          capacityProviderStrategies: [
            {
              capacityProvider: config.useFargateSpot
                ? 'FARGATE_SPOT'
                : 'FARGATE',
              weight: 1,
              base: 1,
            },
          ],
          taskDefinition: taskDefinition,
          platformVersion: ecs.FargatePlatformVersion.LATEST,
          serviceName: constants.SERVICE_NAME + '-' + key,
          desiredCount: 0,
          assignPublicIp: true,
          securityGroups: [serviceSecurityGroup],
        }
      );

      /* Allow access to EFS from Fargate service security group */
      fileSystem.connections.allowDefaultPortFrom(
        minecraftServerService.connections
      );

      const watchdogContainer = new ecs.ContainerDefinition(
        this,
        'WatchDogContainer-' + key,
        {
          containerName: constants.WATCHDOG_SERVER_CONTAINER_NAME + '-' + key,
          image: isDockerInstalled()
            ? ecs.ContainerImage.fromAsset(
                path.resolve(__dirname, '../../minecraft-ecsfargate-watchdog/')
              )
            : ecs.ContainerImage.fromRegistry(
                'doctorray/minecraft-ecsfargate-watchdog'
              ),
          entryPoint: [ '/minecraft/watchdog.sh' ],
          essential: true,
          taskDefinition: taskDefinition,
          environment: {
            CLUSTER: constants.CLUSTER_NAME,
            SERVICE: constants.SERVICE_NAME + '-' + key,
            DNSZONE: hostedZoneId,
            SERVERNAME: `${key}.${config.domainName}`,
            SNSTOPIC: snsTopicArn,
            TWILIOFROM: config.twilio.phoneFrom,
            TWILIOTO: config.twilio.phoneTo,
            TWILIOAID: config.twilio.accountId,
            TWILIOAUTH: config.twilio.authCode,
            STARTUPMIN: config.startupMinutes,
            SHUTDOWNMIN: config.shutdownMinutes,
          },
          logging: config.debug
            ? new ecs.AwsLogDriver({
                logRetention: logs.RetentionDays.THREE_DAYS,
                streamPrefix: constants.WATCHDOG_SERVER_CONTAINER_NAME,
              })
            : undefined,
        }
      );

      watchdogContainer.addMountPoints({
        containerPath: '/minecraft',
        sourceVolume: constants.ECS_VOLUME_NAME,
        readOnly: false,
      });

      const serviceControlPolicy = new iam.Policy(this, 'ServiceControlPolicy-' + key, {
        statements: [
          new iam.PolicyStatement({
            sid: 'AllowAllOnServiceAndTask' + key,
            effect: iam.Effect.ALLOW,
            actions: ['ecs:*'],
            resources: [
              minecraftServerService.serviceArn,
              /* arn:aws:ecs:<region>:<account_number>:task/minecraft/* */
              Arn.format(
                {
                  service: 'ecs',
                  resource: 'task',
                  resourceName: `${constants.CLUSTER_NAME}/*`,
                  arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                },
                this
              ),
            ],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeNetworkInterfaces'],
            resources: ['*'],
          }),
        ],
      });

      serviceControlPolicy.attachToRole(ecsTaskRole);

      /**
       * Add service control policy to the launcher lambda from the other stack
       */
      const launcherLambdaRoleArn = new SSMParameterReader(
        this,
        'launcherLambdaRoleArn-' + key,
        {
          parameterName: constants.LAUNCHER_LAMBDA_ARN_SSM_PARAMETER + '-' + key,
          region: constants.DOMAIN_STACK_REGION,
        }
      ).getParameterValue();
      const launcherLambdaRole = iam.Role.fromRoleArn(
        this,
        'LauncherLambdaRole-' + key,
        launcherLambdaRoleArn
      );
      serviceControlPolicy.attachToRole(launcherLambdaRole);

      /**
       * This policy gives permission to our ECS task to update the A record
       * associated with our minecraft server. Retrieve the hosted zone identifier
       * from Route 53 and place it in the Resource line within this policy.
       */
      const iamRoute53Policy = new iam.Policy(this, 'IamRoute53Policy-' + key, {
        statements: [
          new iam.PolicyStatement({
            sid: 'AllowEditRecordSets',
            effect: iam.Effect.ALLOW,
            actions: [
              'route53:GetHostedZone',
              'route53:ChangeResourceRecordSets',
              'route53:ListResourceRecordSets',
            ],
            resources: [`arn:aws:route53:::hostedzone/${hostedZoneId}`],
          }),
        ],
      });
      iamRoute53Policy.attachToRole(ecsTaskRole);
    })
  }
}
