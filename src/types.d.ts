import {
  CreateTopicResponse,
  ListSubscriptionsCommandOutput,
  ListTopicsCommandOutput,
  PublishCommandOutput,
} from "@aws-sdk/client-sns";

export type IDebug = (msg: any, stack?: any) => void;

export type SLSHandler = (() => Promise<any>) | (() => (event: any, context: any) => void);

export interface ISNSAdapter {
  listTopics(): Promise<ListTopicsCommandOutput>;
  listSubscriptions(): Promise<ListSubscriptionsCommandOutput>;
  unsubscribe(arn: string): Promise<void>;
  createTopic(topicName: string): Promise<CreateTopicResponse>;
  subscribe(fnName: string, handler: SLSHandler, arn: string, snsConfig: any): Promise<void>;
  subscribeQueue(queueUrl: string, arn: string, snsConfig: any): Promise<void>;
  publish(topicArn: string, type: string, message: string): Promise<PublishCommandOutput>;
}

export type ISNSAdapterConstructable = new (
  endpoint: string,
  port: number,
  region: string,
  debug: IDebug
) => ISNSAdapter;

export interface ISNSServer {
  routes();
}

export type MessageAttributes = IMessageAttribute[];

export interface IMessageAttribute {
  Type: string;
  Value: string;
}
