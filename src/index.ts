import { spawn } from "node:child_process";
import type http from "node:http";
import { resolve } from "node:path";
import URL from "node:url";
import cors from "cors";
import express, { type Express } from "express";
import _ from "lodash";
import get from "lodash/fp/get.js";
import has from "lodash/fp/has.js";
import type Serverless from "serverless";
import type { Logging } from "serverless/classes/Plugin.js";
import * as shell from "shelljs";
import { topicNameFromArn } from "./helpers.js";
import { loadServerlessConfig } from "./sls-config-parser.js";
import { SNSAdapter } from "./sns-adapter.js";
import { SNSServer } from "./sns-server.js";
import type { ISNSAdapter } from "./types.js";

export default class ServerlessOfflineSns {
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	private config: any;
	private serverless: Serverless;
	public commands: object;
	private localPort: number;
	private remotePort: number;
	public hooks: object;
	private snsAdapter: ISNSAdapter;
	private app: Express;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	private snsServer: any;
	private server: http.Server;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	private options: any;
	private location: string;
	private region: string;
	private accountId: string;
	private servicesDirectory: string;
	private autoSubscribe: boolean;
	private serverlessLog: Logging["log"];

	constructor(serverless, options: Serverless.Options, { log }) {
		this.serverlessLog = log;
		this.app = express();
		this.app.use(cors());
		this.app.use((req, res, next) => {
			// fix for https://github.com/s12v/sns/issues/45 not sending content-type
			req.headers["content-type"] = req.headers["content-type"] || "text/plain";
			next();
		});
		this.app.use(
			express.json({ limit: "10MB", type: ["application/json", "text/plain"] }),
		);
		this.options = options;
		this.serverless = serverless;

		this.commands = {
			"offline-sns": {
				usage:
					"Listens to offline SNS events and passes them to configured Lambda fns",
				lifecycleEvents: ["start", "cleanup"],
				commands: {
					start: {
						lifecycleEvents: ["init", "end"],
					},
					cleanup: {
						lifecycleEvents: ["init"],
					},
				},
			},
		};

		this.hooks = {
			"before:offline:start": () => this.start(),
			"before:offline:start:init": () => this.start(),
			"after:offline:start:end": () => this.stop(),
			"offline-sns:start:init": () => {
				this.start();
				return this.waitForSigint();
			},
			"offline-sns:cleanup:init": async () => {
				this.init();
				this.setupSnsAdapter();
				return this.unsubscribeAll();
			},
			"offline-sns:start:end": () => this.stop(),
		};
	}

	public init() {
		const env = {};
		for (const funcKey in this.serverless.service.functions) {
			env[funcKey] = this.serverless.service.functions[funcKey].environment;
		}
		process.env = _.extend(
			{ AWS_REGION: this.serverless.service.provider.region },
			env,
			process.env,
		);
		this.config =
			this.serverless.service.custom["serverless-offline-sns"] || {};
		this.localPort = this.config.port || this.config.localPort || 4002;
		this.remotePort = this.config.port || this.config.remotePort || 4002;
		this.accountId = this.config.accountId || "123456789012";
		const offlineConfig =
			this.serverless.service.custom["serverless-offline"] || {};
		this.servicesDirectory = this.config.servicesDirectory || "";
		this.location = process.cwd();
		const locationRelativeToCwd =
			this.options.location || this.config.location || offlineConfig.location;
		if (locationRelativeToCwd) {
			this.location = `${process.cwd()}/${locationRelativeToCwd}`;
		} else if (this.serverless.config.servicePath) {
			this.location = this.serverless.config.servicePath;
		}
		if (this.serverless.service.provider.region) {
			this.region = this.serverless.service.provider.region;
		} else {
			this.region = "us-east-1";
		}
		this.autoSubscribe =
			this.config.autoSubscribe === undefined
				? true
				: this.config.autoSubscribe;
		// Configure SNS client to be able to find us.
		// AWS.config.sns = {
		//   endpoint: "http://127.0.0.1:" + this.localPort,
		//   region: this.region,
		// };
	}

	public async start() {
		this.init();
		await this.listen();
		await this.serve();
		await this.subscribeAll();
		return this.snsAdapter;
	}

	public async waitForSigint() {
		return new Promise((res) => {
			process.on("SIGINT", () => {
				this.log("Halting offline-sns server");
				res(true);
			});
		});
	}

	public async serve() {
		this.snsServer = new SNSServer(
			(msg, ctx) => this.debug(msg, ctx),
			this.app,
			this.region,
			this.accountId,
		);
	}
	private getFunctionName(name) {
		let result: string;
		// biome-ignore lint/complexity/noForEach: <explanation>
		Object.entries(this.serverless.service.functions).forEach(
			([funcName, funcValue]) => {
				const events = get(["events"], funcValue);
				// biome-ignore lint/complexity/noForEach: <explanation>
				events?.forEach((event) => {
					const attribute = get(["sqs", "arn"], event);
					if (!has("Fn::GetAtt", attribute)) return;
					const [resourceName, value] = attribute["Fn::GetAtt"];
					if (value !== "Arn") return;
					if (name !== resourceName) return;
					result = funcName;
				});
			},
		);
		return result;
	}

	private getResourceSubscriptions(serverless) {
		const resources = serverless.service.resources?.Resources;
		const subscriptions = [];
		if (!resources) return subscriptions;
		new Map(Object.entries(resources)).forEach((value, key) => {
			let type = get(["Type"], value);
			if (type !== "AWS::SNS::Subscription") return;

			const endPoint = get(["Properties", "Endpoint"], value);
			if (!has("Fn::GetAtt", endPoint)) return;

			const [resourceName, attribute] = endPoint["Fn::GetAtt"];
			type = get(["Type"], resources[resourceName]);
			if (attribute !== "Arn") return;
			if (type !== "AWS::SQS::Queue") return;

			const filterPolicy = get(["Properties", "FilterPolicy"], value);
			const protocol = get(["Properties", "Protocol"], value);
			const rawMessageDelivery = get(
				["Properties", "RawMessageDelivery"],
				value,
			);
			const topicArn = get(["Properties", "TopicArn", "Ref"], value);
			const topicName = get(["Properties", "TopicName"], resources[topicArn]);
			const fnName = this.getFunctionName(resourceName);
			subscriptions.push({
				fnName,
				options: {
					topicName,
					protocol,
					rawMessageDelivery,
					filterPolicy,
				},
			});
		});
		return subscriptions;
	}
	public async subscribeAll() {
		this.setupSnsAdapter();
		await this.unsubscribeAll();
		this.debug("subscribing functions");
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		const subscribePromises: Array<Promise<any>> = [];
		if (this.autoSubscribe) {
			if (this.servicesDirectory) {
				shell.cd(this.servicesDirectory);
				for (const directory of shell.ls("-d", "*/")) {
					shell.cd(directory);
					const service = directory.split("/")[0];
					const serverless = await loadServerlessConfig(
						shell.pwd().toString(),
						this.debug,
					);
					this.debug("Processing subscriptions for ", service);
					this.debug("shell.pwd()", shell.pwd());
					this.debug(
						"serverless functions",
						JSON.stringify(serverless.service.functions, undefined, 2),
					);
					const subscriptions = this.getResourceSubscriptions(serverless);
					for (const subscription of subscriptions) {
						subscribePromises.push(
							this.subscribeFromResource(subscription, this.location),
						);
					}
					Object.keys(serverless.service.functions).map((fnName) => {
						const fn = serverless.service.functions[fnName];
						subscribePromises.push(
							Promise.all(
								fn.events
									.filter((event) => event.sns != null)
									.map((event) => {
										return this.subscribe(
											serverless,
											fnName,
											event.sns,
											shell.pwd(),
										);
									}),
							),
						);
					});
					shell.cd("../");
				}
			} else {
				const subscriptions = this.getResourceSubscriptions(this.serverless);
				for (const subscription of subscriptions) {
					subscribePromises.push(
						this.subscribeFromResource(subscription, this.location),
					);
				}
				Object.keys(this.serverless.service.functions).map((fnName) => {
					const fn = this.serverless.service.functions[fnName];
					subscribePromises.push(
						Promise.all(
							fn.events
								.filter((event) => event.sns != null)
								.map((event) => {
									return this.subscribe(
										this.serverless,
										fnName,
										event.sns,
										this.location,
									);
								}),
						),
					);
				});
			}
		}
		await this.subscribeAllQueues(subscribePromises);
	}

	private async subscribeAllQueues(subscribePromises) {
		await Promise.all(subscribePromises);
		this.debug("subscribing queues");
		await Promise.all(
			(this.config.subscriptions || []).map((sub) => {
				return this.subscribeQueue(sub.queue, sub.topic);
			}),
		);
	}

	private async subscribeFromResource(subscription, location) {
		this.debug(`subscribe: ${subscription.fnName}`);
		this.log(
			`Creating topic: "${subscription.options.topicName}" for fn "${subscription.fnName}"`,
		);
		const data = await this.snsAdapter.createTopic(
			subscription.options.topicName,
		);
		this.debug(`topic: ${JSON.stringify(data, undefined, 2)}`);
		const fn = this.serverless.service.functions[subscription.fnName];
		await this.snsAdapter.subscribe(
			subscription.fnName, //To Verify
			this.createHandler(subscription.fnName, fn, location),
			data.TopicArn,
			subscription.options,
		);
	}
	public async unsubscribeAll() {
		const subs = await this.snsAdapter.listSubscriptions();
		this.debug(`subs!: ${JSON.stringify(subs, undefined, 2)}`);
		await Promise.all(
			subs.Subscriptions.filter(
				(sub) => sub.Endpoint.indexOf(`:${this.remotePort}`) > -1,
			)
				.filter((sub) => sub.SubscriptionArn !== "PendingConfirmation")
				.map((sub) => this.snsAdapter.unsubscribe(sub.SubscriptionArn)),
		);
	}

	public async subscribe(serverless, fnName, snsConfig, lambdasLocation) {
		this.debug(`subscribe: ${fnName}`);
		const fn = serverless.service.functions[fnName];

		if (!fn.runtime) {
			fn.runtime = serverless.service.provider.runtime;
		}

		let topicName = "";

		// https://serverless.com/framework/docs/providers/aws/events/sns#using-a-pre-existing-topic
		if (typeof snsConfig === "string") {
			if (snsConfig.indexOf("arn:aws:sns") === 0) {
				topicName = topicNameFromArn(snsConfig);
			} else {
				topicName = snsConfig;
			}
		} else if (snsConfig.topicName && typeof snsConfig.topicName === "string") {
			topicName = snsConfig.topicName;
		} else if (snsConfig.arn && typeof snsConfig.arn === "string") {
			topicName = topicNameFromArn(snsConfig.arn);
		}

		if (!topicName) {
			this.log(
				`Unable to create topic for "${fnName}". Please ensure the sns configuration is correct.`,
			);
			return Promise.resolve(
				`Unable to create topic for "${fnName}". Please ensure the sns configuration is correct.`,
			);
		}

		this.log(`Creating topic: "${topicName}" for fn "${fnName}"`);
		const data = await this.snsAdapter.createTopic(topicName);
		this.debug(`topic: ${JSON.stringify(data, undefined, 2)}`);
		await this.snsAdapter.subscribe(
			fn,
			this.createHandler(fnName, fn, lambdasLocation),
			data.TopicArn,
			snsConfig,
		);
	}

	public async subscribeQueue(queueUrl, snsConfig) {
		this.debug(`subscribe: ${queueUrl}`);
		let topicName = "";

		// https://serverless.com/framework/docs/providers/aws/events/sns#using-a-pre-existing-topic
		if (typeof snsConfig === "string") {
			if (snsConfig.indexOf("arn:aws:sns") === 0) {
				topicName = topicNameFromArn(snsConfig);
			} else {
				topicName = snsConfig;
			}
		} else if (snsConfig.topicName && typeof snsConfig.topicName === "string") {
			topicName = snsConfig.topicName;
		} else if (snsConfig.arn && typeof snsConfig.arn === "string") {
			topicName = topicNameFromArn(snsConfig.arn);
		}

		if (!topicName) {
			this.log(
				`Unable to create topic for "${queueUrl}". Please ensure the sns configuration is correct.`,
			);
			return Promise.resolve(
				`Unable to create topic for "${queueUrl}". Please ensure the sns configuration is correct.`,
			);
		}

		this.log(`Creating topic: "${topicName}" for queue "${queueUrl}"`);
		const data = await this.snsAdapter.createTopic(topicName);
		this.debug(`topic: ${JSON.stringify(data, undefined, 2)}`);
		await this.snsAdapter.subscribeQueue(queueUrl, data.TopicArn, snsConfig);
	}

	public createHandler(fnName, fn, location) {
		if (!fn.runtime || fn.runtime.startsWith("nodejs")) {
			return this.createJavascriptHandler(fn, location);
		}
		return () => this.createProxyHandler(fnName, fn, location);
	}

	public createProxyHandler(funName, funOptions, location) {
		const options = this.options;
		return (event, context) => {
			const args = ["invoke", "local", "-f", funName];
			const stage = options.s || options.stage;

			if (stage) {
				args.push("-s", stage);
			}

			// Use path to binary if provided, otherwise assume globally-installed
			const binPath = options.b || options.binPath;
			const cmd = binPath || "sls";

			const process = spawn(cmd, args, {
				cwd: location,
				shell: true,
				stdio: ["pipe", "pipe", "pipe"],
			});

			process.stdin.write(`${JSON.stringify(event, undefined, 2)}\n`);
			process.stdin.end();

			const results = [];
			let error = false;

			process.stdout.on("data", (data) => {
				if (data) {
					const str = data.toString();
					if (str) {
						// should we check the debug flag & only log if debug is true?
						console.log(str);
						results.push(data.toString());
					}
				}
			});

			process.stderr.on("data", (data) => {
				error = true;
				console.warn("error", data);
				context.fail(data);
			});

			process.on("close", (code) => {
				if (!error) {
					// try to parse to json
					// valid result should be a json array | object
					// technically a string is valid json
					// but everything comes back as a string
					// so we can't reliably detect json primitives with this method
					let response = null;
					// we go end to start because the one we want should be last
					// or next to last
					for (let i = results.length - 1; i >= 0; i--) {
						// now we need to find the min | max [] or {} within the string
						// if both exist then we need the outer one.
						// { "something": [] } is valid,
						// [{"something": "valid"}] is also valid
						// *NOTE* Doesn't currently support 2 separate valid json bundles
						// within a single result.
						// this can happen if you use a python logger
						// and then do log.warn(json.dumps({'stuff': 'here'}))
						const item = results[i];
						const firstCurly = item.indexOf("{");
						const firstSquare = item.indexOf("[");
						let start = 0;
						let end = item.length;
						if (firstCurly === -1 && firstSquare === -1) {
							// no json found
							continue;
						}
						if (firstSquare === -1 || firstCurly < firstSquare) {
							// found an object
							start = firstCurly;
							end = item.lastIndexOf("}") + 1;
						} else if (firstCurly === -1 || firstSquare < firstCurly) {
							// found an array
							start = firstSquare;
							end = item.lastIndexOf("]") + 1;
						}

						try {
							response = JSON.parse(item.substring(start, end));
							break;
						} catch (err) {}
					}
					if (response !== null) {
						context.succeed(response);
					} else {
						context.succeed(results.join("\n"));
					}
				}
			});
		};
	}

	public createJavascriptHandler(fn, location) {
		return async () => {
			// Options are passed from the command line in the options parameter
			// ### OLD: use the main serverless config since this behavior is already supported there
			// if (!this.options.skipCacheInvalidation || Array.isArray(this.options.skipCacheInvalidation)) {
			//   for (const key in require.cache) {
			//     // don't invalidate cached modules from node_modules ...
			//     if (key.match(/node_modules/)) {
			//       continue;
			//     }

			//     // if an array is provided to the serverless config, check the entries there too
			//     if (
			//       Array.isArray(this.options.skipCacheInvalidation) &&
			//       this.options.skipCacheInvalidation.find((pattern) => new RegExp(pattern).test(key))
			//     ) {
			//       continue;
			//     }

			//     delete require.cache[key];
			//   }
			// }

			this.debug(process.cwd());
			const handlerFnNameIndex = fn.handler.lastIndexOf(".");
			const handlerPath = fn.handler.substring(0, handlerFnNameIndex);
			const handlerFnName = fn.handler.substring(handlerFnNameIndex + 1);
			const fullHandlerPath = `${resolve(location, handlerPath)}.js`;
			this.debug(
				`import(${URL.pathToFileURL(fullHandlerPath).toString()})[${handlerFnName}]`,
			);
			const { [handlerFnName]: handler } = await import(
				URL.pathToFileURL(fullHandlerPath).toString()
			);
			return handler;
		};
	}

	public log(msg, prefix = "INFO[serverless-offline-sns]: ") {
		this.serverlessLog.info(prefix + msg);
	}

	public debug(msg, context?: string) {
		if (this.config.debug) {
			if (context) {
				this.log(msg, `DEBUG[serverless-offline-sns][${context}]: `);
			} else {
				this.log(msg, "DEBUG[serverless-offline-sns]: ");
			}
		}
	}

	public async listen() {
		this.debug("starting plugin");
		let host = "127.0.0.1";
		if (this.config.host) {
			this.debug(`using specified host ${this.config.host}`);
			host = this.config.host;
		} else if (this.options.host) {
			this.debug(`using offline specified host ${this.options.host}`);
			host = this.options.host;
		}
		return new Promise((res) => {
			this.server = this.app.listen(this.localPort, host, () => {
				this.debug(`listening on ${host}:${this.localPort}`);
				res(true);
			});
			this.server.setTimeout(0);
		});
	}

	public async stop() {
		this.init();
		this.debug("stopping plugin");
		if (this.server) {
			this.server.close();
		}
	}

	private setupSnsAdapter() {
		this.snsAdapter = new SNSAdapter(
			this.localPort,
			this.remotePort,
			this.serverless.service.provider.region,
			this.config["sns-endpoint"],
			(msg, ctx) => this.debug(msg, ctx),
			this.app,
			this.serverless.service.service,
			this.serverless.service.provider.stage,
			this.accountId,
			this.config.host,
			this.config["sns-subscribe-endpoint"],
		);
	}
}
