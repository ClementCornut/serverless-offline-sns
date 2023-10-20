import {
  SNSClient,
  ListTopicsCommand,
  ListSubscriptionsCommand,
  ListTopicsResponse,
  UnsubscribeCommand,
  CreateTopicCommand,
  SubscribeCommand,
  PublishCommand,
  PublishInput,
  ListSubscriptionsCommandOutput,
  PublishCommandOutput,
  ListTopicsCommandOutput,
} from "@aws-sdk/client-sns";
import _ from "lodash";
import fetch from "node-fetch";
import { createMessageId, createSnsLambdaEvent } from "./helpers.js";
import { IDebug, ISNSAdapter } from "./types.js";

export class SNSAdapter implements ISNSAdapter {
  private sns: SNSClient;
  private pluginDebug: IDebug;
  private port: number;
  private server: any;
  private app: any;
  private serviceName: string;
  private stage: string;
  private endpoint: string;
  private adapterEndpoint: string;
  private baseSubscribeEndpoint: string;
  private accountId: string;

  constructor(
    localPort,
    remotePort,
    region,
    snsEndpoint,
    debug,
    app,
    serviceName,
    stage,
    accountId,
    host,
    subscribeEndpoint
  ) {
    this.pluginDebug = debug;
    this.app = app;
    this.serviceName = serviceName;
    this.stage = stage;
    this.adapterEndpoint = `http://${host || "127.0.0.1"}:${localPort}`;
    this.baseSubscribeEndpoint = subscribeEndpoint ? `http://${subscribeEndpoint}:${remotePort}` : this.adapterEndpoint;
    this.endpoint = snsEndpoint || `http://127.0.0.1:${localPort}`;
    this.debug("using endpoint: " + this.endpoint);
    this.accountId = accountId;

    this.sns = new SNSClient({
      endpoint: this.endpoint,
      region,
    });
  }

  public async listTopics(): Promise<ListTopicsCommandOutput> {
    this.debug("listing topics");

    return new Promise((res) => {
      this.sns.send(new ListTopicsCommand({}), (err, topics) => {
        if (err) {
          this.debug(err, err.stack);
        } else {
          this.debug(JSON.stringify(topics));
        }
        res(topics);
      });
    });
  }

  public async listSubscriptions(): Promise<ListSubscriptionsCommandOutput> {
    this.debug("listing subs");

    return new Promise((res) => {
      this.sns.send(new ListSubscriptionsCommand({}), (err, subs) => {
        if (err) {
          this.debug(err, err.stack);
        } else {
          this.debug(JSON.stringify(subs));
        }
        res(subs);
      });
    });
  }

  public async unsubscribe(arn) {
    this.debug("unsubscribing: " + arn);
    await new Promise((res) => {
      this.sns.send(
        new UnsubscribeCommand({
          SubscriptionArn: arn,
        }),
        (err, data) => {
          if (err) {
            this.debug(err, err.stack);
          } else {
            this.debug("unsubscribed: " + JSON.stringify(data));
          }
          res(true);
        }
      );
    });
  }

  public async createTopic(topicName) {
    return new Promise((res) =>
      this.sns.send(new CreateTopicCommand({ Name: topicName }), (err, data) => {
        if (err) {
          this.debug(err, err.stack);
        } else {
          this.debug("arn: " + JSON.stringify(data));
        }
        res(data);
      })
    );
  }

  private sent: (data) => void;
  public Deferred = new Promise((res) => (this.sent = res));

  public async subscribe(fn, getHandler, arn, snsConfig) {
    arn = this.convertPseudoParams(arn);
    const subscribeEndpoint = this.baseSubscribeEndpoint + "/" + fn.name;
    this.debug("subscribe: " + fn.name + " " + arn);
    this.debug("subscribeEndpoint: " + subscribeEndpoint);
    this.app.post("/" + fn.name, (req, res) => {
      this.debug("calling fn: " + fn.name + " 1");
      const oldEnv = _.extend({}, process.env);
      process.env = _.extend({}, process.env, fn.environment);

      let event = req.body;
      if (req.is("text/plain") && req.get("x-amz-sns-rawdelivery") !== "true") {
        const msg = event.MessageStructure === "json" ? JSON.parse(event.Message).default : event.Message;
        event = createSnsLambdaEvent(
          event.TopicArn,
          "EXAMPLE",
          event.Subject || "",
          msg,
          event.MessageId || createMessageId(),
          event.MessageAttributes || {},
          event.MessageGroupId
        );
      }

      if (req.body.SubscribeURL) {
        this.debug("Visiting subscribe url: " + req.body.SubscribeURL);
        return fetch(req.body.SubscribeURL, {
          method: "GET",
        }).then((fetchResponse) => this.debug("Subscribed: " + fetchResponse));
      }

      const sendIt = (err, response) => {
        process.env = oldEnv;
        if (err) {
          res.status(500).send(err);
          this.sent(err);
        } else {
          res.send(response);
          this.sent(response);
        }
      };
      const maybePromise = getHandler()(event, this.createLambdaContext(fn, sendIt), sendIt);
      if (maybePromise && maybePromise.then) {
        maybePromise.then((response) => sendIt(null, response)).catch((error) => sendIt(error, null));
      }
    });
    const params = {
      Protocol: snsConfig.protocol || "http",
      TopicArn: arn,
      Endpoint: subscribeEndpoint,
      Attributes: {},
    };

    if (snsConfig.rawMessageDelivery === "true") {
      params.Attributes["RawMessageDelivery"] = "true";
    }
    if (snsConfig.filterPolicy) {
      params.Attributes["FilterPolicy"] = JSON.stringify(snsConfig.filterPolicy);
    }

    await new Promise((res) => {
      this.sns.send(new SubscribeCommand(params), (err, data) => {
        if (err) {
          this.debug(err, err.stack);
        } else {
          this.debug(`successfully subscribed fn "${fn.name}" to topic: "${arn}"`);
        }
        res(true);
      });
    });
  }

  public async subscribeQueue(queueUrl, arn, snsConfig) {
    arn = this.convertPseudoParams(arn);
    this.debug("subscribe: " + queueUrl + " " + arn);
    const params = {
      Protocol: snsConfig.protocol || "sqs",
      TopicArn: arn,
      Endpoint: queueUrl,
      Attributes: {},
    };

    if (snsConfig.rawMessageDelivery === "true") {
      params.Attributes["RawMessageDelivery"] = "true";
    }
    if (snsConfig.filterPolicy) {
      params.Attributes["FilterPolicy"] = JSON.stringify(snsConfig.filterPolicy);
    }

    await new Promise((res) => {
      this.sns.send(new SubscribeCommand(params), (err, data) => {
        if (err) {
          this.debug(err, err.stack);
        } else {
          this.debug(`successfully subscribed queue "${queueUrl}" to topic: "${arn}"`);
        }
        res(true);
      });
    });
  }

  public convertPseudoParams(topicArn) {
    const awsRegex = /#{AWS::([a-zA-Z]+)}/g;
    return topicArn.replace(awsRegex, this.accountId);
  }

  public async publish(
    topicArn: string,
    message: string,
    type: string = "",
    messageAttributes: PublishInput["MessageAttributes"] = {},
    subject: string = "",
    messageGroupId?: string
  ) {
    topicArn = this.convertPseudoParams(topicArn);
    return new Promise<PublishCommandOutput>((resolve, reject) =>
      this.sns.send(
        new PublishCommand({
          Message: message,
          Subject: subject,
          MessageStructure: type,
          TopicArn: topicArn,
          MessageAttributes: messageAttributes,
          ...(messageGroupId && { MessageGroupId: messageGroupId }),
        }),
        (err, result) => {
          resolve(result);
        }
      )
    );
  }

  public async publishToTargetArn(
    targetArn: string,
    message: string,
    type: string = "",
    messageAttributes: PublishInput["MessageAttributes"] = {},
    messageGroupId?: string
  ) {
    targetArn = this.convertPseudoParams(targetArn);
    return new Promise((resolve, reject) =>
      this.sns.send(
        new PublishCommand({
          Message: message,
          MessageStructure: type,
          TargetArn: targetArn,
          MessageAttributes: messageAttributes,
          ...(messageGroupId && { MessageGroupId: messageGroupId }),
        }),
        (err, result) => {
          resolve(result);
        }
      )
    );
  }

  public async publishToPhoneNumber(
    phoneNumber: string,
    message: string,
    type: string = "",
    messageAttributes: PublishInput["MessageAttributes"] = {},
    messageGroupId?: string
  ) {
    return new Promise((resolve, reject) =>
      this.sns.send(
        new PublishCommand({
          Message: message,
          MessageStructure: type,
          PhoneNumber: phoneNumber,
          MessageAttributes: messageAttributes,
          ...(messageGroupId && { MessageGroupId: messageGroupId }),
        }),
        (err, result) => {
          resolve(result);
        }
      )
    );
  }

  public debug(msg, stack?: any) {
    this.pluginDebug(msg, "adapter");
  }

  private createLambdaContext(fun, cb?) {
    const functionName = `${this.serviceName}-${this.stage}-${fun.name}`;
    const endTime = new Date().getTime() + (fun.timeout ? fun.timeout * 1000 : 6000);
    const done = typeof cb === "function" ? cb : (x, y) => x || y; // eslint-disable-line no-extra-parens

    return {
      /* Methods */
      done,
      succeed: (res) => done(null, res),
      fail: (err) => done(err, null),
      getRemainingTimeInMillis: () => endTime - new Date().getTime(),

      /* Properties */
      functionName,
      memoryLimitInMB: fun.memorySize || 1536,
      functionVersion: `offline_functionVersion_for_${functionName}`,
      invokedFunctionArn: `offline_invokedFunctionArn_for_${functionName}`,
      awsRequestId: `offline_awsRequestId_${Math.random().toString(10).slice(2)}`,
      logGroupName: `offline_logGroupName_for_${functionName}`,
      logStreamName: `offline_logStreamName_for_${functionName}`,
      identity: {},
      clientContext: {},
    };
  }
}
