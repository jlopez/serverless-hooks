const _ = require('lodash');
const path = require('path');
const fs = require('fs');
const tmp = require('tmp-promise');
const exitHook = require('async-exit-hook');
const runAll = require('npm-run-all');

class ServerlessHooks {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.pluginName = 'serverless-hooks';

    this.usedStandardStreams = new Set();
    this.config = serverless.service.custom[this.pluginName] || {};
    this.hookPrefix = `${_.trimEnd(this.config.hookPrefix || 'hook', ':')}:`;
    this.runAllOptions = _.merge({ stdin: 0, stdout: 1, stderr: 1 }, this.config.runAllOptions);
    _.forEach(['stdin', 'stdout', 'stderr'], (n) => this.setupStream(n));

    this.hooks = this.buildHooksObject();
  }

  setupStream(stream) {
    const value = this.runAllOptions[stream] || null;
    const isWritable = stream !== 'stdin';
    this.runAllOptions[stream] = _.isString(value) || _.isObject(value)
      ? ServerlessHooks.createStream(value, isWritable)
      : value && this.allocateStdStream(stream);
  }

  allocateStdStream(name) {
    this.usedStandardStreams.add(name);
    return process[name];
  }

  static createStream(value, isWritable) {
    const info = _.isString(value) ? { name: value } : value;
    const createStream = isWritable ? fs.createWriteStream : fs.createReadStream;
    return createStream(info.name, info);
  }

  debug(msg) {
    if (process.env.SLS_DEBUG) {
      this.serverless.cli.log(msg, this.pluginName);
    }
  }

  buildHooksObject() {
    const nodeScripts = this.getNodeScripts();
    return _.chain(nodeScripts)
      .toPairs()
      .filter(([k]) => _.startsWith(k, this.hookPrefix))
      .map(([k, v]) => this.getHookRunner(k, !v))
      .fromPairs()
      .value();
  }

  getNodeScripts() {
    const rootPath = this.serverless.config.servicePath;
    const packageJsonPath = path.join(rootPath, 'package.json');
    try {
      return {
        'hook:initialize': null,
        // eslint-disable-next-line global-require, import/no-dynamic-require
        ...require(packageJsonPath).scripts,
      };
    } catch (error) {
      return {};
    }
  }

  getHookRunner(scriptName, isSynthetic) {
    const trimLength = this.hookPrefix.length;
    const hook = scriptName.slice(trimLength);
    const isInitializeHook = hook === 'initialize';
    const hookRunner = isInitializeHook ? this.onInitialize : this.onHook;
    return [hook, hookRunner.bind(this, scriptName, isSynthetic)];
  }

  async onInitialize(scriptName, isSynthetic) {
    await this.setupServerlessContext();
    this.usedStandardStreams.forEach((name) => process[name].setMaxListeners(0));
    if (isSynthetic) return undefined;
    return this.onHook();
  }

  async setupServerlessContext() {
    const context = this.createServerlessContext();
    const json = JSON.stringify(context);
    const tmpPath = await tmp.tmpName();
    process.env.SLS_CONTEXT = tmpPath;
    await fs.promises.writeFile(tmpPath, json);
    exitHook(() => fs.unlinkSync(tmpPath));
  }

  createServerlessContext() {
    const { serverless } = this;
    return {
      invocationId: serverless.invocationId,
      version: serverless.version,
      cliCommands: serverless.pluginManager.cliCommands,
      cliOptions: serverless.pluginManager.cliOptions,
      servicePath: serverless.config.servicePath,
      service: _.chain(serverless.service)
        .pick(['service', 'custom', 'plugins', 'provider', 'functions', 'resources',
          'package', 'frameworkVersion', 'app', 'tenant', 'org', 'layers', 'outputs'])
        .pickBy()
        .value(),
    };
  }

  async onHook(scriptName) {
    this.debug(`Running hook script ${scriptName}`);
    return runAll(scriptName, this.runAllOptions);
  }
}

module.exports = ServerlessHooks;
