import { Client, type ClientOptions } from 'discord.js';
import type { EventEmitter } from 'node:events';
import type { RuntimeCoordinator } from './coordinator';
import { accountDiscordEmitter, accountSdkCallbackEmitter } from './ingress';
import { safeDiscordRoute } from './failureEvidence';

/** SDK queues and gateway throttlers have unused internal head promises. Own the
 * concrete returned operation, not those SDK lifetimes. Feature callbacks enter
 * independently through the accounted emitter, and each REST effect still has
 * its own admission, awaited completion and required failure disposition. */
export function createRuntimeDiscordClient(runtime: RuntimeCoordinator, options: ClientOptions): Client {
  const client = runtime.initializeSdkLifetime(() => new Client(options));
  accountDiscordEmitter(client, runtime);
  // REST uses a typed AsyncEventEmitter with the same synchronous emit contract.
  // Its application response/debug/rate-limit listeners need independent scopes.
  accountSdkCallbackEmitter(client.rest as unknown as EventEmitter, runtime, 'discord-rest-event');
  const request = client.rest.request.bind(client.rest);
  client.rest.request = options => {
    const operation = async () => await runtime.initializeSdkLifetime(() => request(options));
    return options.method === 'GET'
      ? runtime.run('discord-rest:GET', operation)
      : runtime.required(`discord-rest:${options.method}`, operation,
        { routeTemplate: safeDiscordRoute(options.fullRoute), stage: 'discord-rest-completion-unconfirmed' });
  };
  const destroy = client.destroy.bind(client);
  client.destroy = () => runtime.run('discord:close', async () => {
    await runtime.initializeSdkLifetime(() => destroy());
  }, true);
  return client;
}

/** Preserve the existing bounded initial login and background SDK reconnect
 * contract. The losing timeout and SDK race promises belong to this one client;
 * only the bounded returned result is startup work. Destroy closes its lifetime. */
export function loginRuntimeDiscordClient(runtime: RuntimeCoordinator, client: Client,
  token: string, timeoutMs: number): Promise<void> {
  return runtime.run('discord:login', async () => {
    await runtime.initializeSdkLifetime(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([client.login(token), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Discord login timed out')), timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    });
  });
}
