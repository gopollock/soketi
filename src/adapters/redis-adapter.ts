import { AdapterInterface } from './adapter-interface';
import { HorizontalAdapter, PubsubBroadcastedMessage } from './horizontal-adapter';
import { Log } from '../log';
import { Server } from '../server';

const Redis = require('ioredis');

export class RedisAdapter extends HorizontalAdapter {
    /**
     * The channel to broadcast the information.
     */
    protected channel = 'redis-adapter';

    /**
     * The subscription client.
     */
    protected subClient: typeof Redis;

    /**
     * The publishing client.
     */
    protected pubClient: typeof Redis;

    /**
     * Initialize the adapter.
     */
    constructor(server: Server) {
        super(server);

        if (server.options.adapter.redis.prefix) {
            this.channel = server.options.adapter.redis.prefix + '#' + this.channel;
        }

        this.requestChannel = `${this.channel}#comms#req`;
        this.responseChannel = `${this.channel}#comms#res`;

        this.requestsTimeout = server.options.adapter.redis.requestsTimeout;
    }

    /**
     * Initialize the adapter.
     */
    async init(): Promise<AdapterInterface> {
        let redisOptions = {
            maxRetriesPerRequest: 2,
            retryStrategy: times => times * 2,
            ...this.server.options.database.redis,
            ...this.server.options.adapter.redis.redisOptions,
        };

        this.subClient = this.server.options.adapter.redis.clusterMode
            ? new Redis.Cluster(this.server.options.database.redis.clusterNodes, { redisOptions })
            : new Redis(redisOptions);

        this.pubClient = this.server.options.adapter.redis.clusterMode
            ? new Redis.Cluster(this.server.options.database.redis.clusterNodes, { redisOptions })
            : new Redis(redisOptions);

        const onError = err => {
            if (err) {
                Log.warning(err);
            }
        };

        this.subClient.psubscribe(`${this.channel}*`, onError);

        this.subClient.on('pmessageBuffer', this.onMessage.bind(this));
        this.subClient.on('messageBuffer', this.processMessage.bind(this));

        this.subClient.subscribe([this.requestChannel, this.responseChannel], onError);

        this.pubClient.on('error', onError);
        this.subClient.on('error', onError);

        return this;
    }

    /**
     * Broadcast data to a given channel.
     */
    protected broadcastToChannel(channel: string, data: string): void {
        this.pubClient.publish(channel, data);
    }

    /**
     * Process the incoming message and redirect it to the right processor.
     */
    protected processMessage(redisChannel: string, msg: Buffer|string): void {
        redisChannel = redisChannel.toString();
        msg = msg.toString();

        if (redisChannel.startsWith(this.responseChannel)) {
            this.onResponse(redisChannel, msg);
        } else if (redisChannel.startsWith(this.requestChannel)) {
            this.onRequest(redisChannel, msg);
        }
    }

    /**
     * Listen for message coming from other nodes to broadcast
     * a specific message to the local sockets.
     */
    protected onMessage(pattern: string, redisChannel: string, msg: Buffer|string): void {
        redisChannel = redisChannel.toString();
        msg = msg.toString();

        // This channel is just for the en-masse broadcasting, not for processing
        // the request-response cycle to gather info across multiple nodes.
        if (!redisChannel.startsWith(this.channel)) {
            return;
        }

        let decodedMessage: PubsubBroadcastedMessage = JSON.parse(msg);

        if (typeof decodedMessage !== 'object') {
            return;
        }

        const { uuid, appId, channel, data, exceptingId } = decodedMessage;

        if (uuid === this.uuid || !appId || !channel || !data) {
            return;
        }

        super.sendLocally(appId, channel, data, exceptingId);
    }

    /**
     * Get the number of Redis subscribers.
     */
    protected getNumSub(): Promise<number> {
        if (this.server.options.adapter.redis.clusterMode) {
            const nodes = this.pubClient.nodes();

            return Promise.all(
                nodes.map((node) =>
                    node.send_command('pubsub', ['numsub', this.requestChannel])
                )
            ).then((values: any[]) => {
                let number = values.reduce((numSub, value) => {
                    return numSub += parseInt(value[1], 10);
                }, 0);

                if (this.server.options.debug) {
                    Log.info(`Found ${number} subscribers in the Redis cluster.`);
                }

                return number;
            });
        } else {
            // RedisClient or Redis
            return new Promise((resolve, reject) => {
                this.pubClient.send_command(
                    'pubsub',
                    ['numsub', this.requestChannel],
                    (err, numSub) => {
                        if (err) {
                            return reject(err);
                        }

                        let number = parseInt(numSub[1], 10);

                        if (this.server.options.debug) {
                            Log.info(`Found ${number} subscribers in the Redis cluster.`);
                        }

                        resolve(number);
                    }
                );
            });
        }
    }

    /**
     * Clear the connections.
     */
    disconnect(): Promise<void> {
        this.subClient.disconnect();
        this.pubClient.disconnect();

        return Promise.resolve();
    }
}
