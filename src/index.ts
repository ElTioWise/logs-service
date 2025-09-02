import { connect, Channel, ConsumeMessage, ChannelModel} from 'amqplib';
import {Client as ElasticsearchClient, ClientOptions} from '@elastic/elasticsearch';
import {BulkResponse} from '@elastic/elasticsearch/lib/api/types';
import 'dotenv/config';

// --- Tipos y Interfaces ---

// CAMBIO: Almacenamos el mensaje completo de RabbitMQ para un ack/nack correcto.
interface BatchMessage {
    content: LogEntry;
    originalMessage: ConsumeMessage; // Guardamos el mensaje original
    timestamp: Date;
}

interface LogEntry {
    '@timestamp': string;
    level: string;
    message: string;
    service: string;
    environment?: string;
    host?: string;
    tags?: string[];
    fields?: Record<string, any>;

    [key: string]: any;
}

interface ConsumerConfig {
    rabbitmq: {
        url: string;
        queueName: string;
        deadLetterQueue: string;
        prefetchCount: number;
    };
    batch: {
        size: number;
        timeoutMs: number;
        maxRetries: number;
    };
    elasticsearch: {
        node: string;
        username?: string;
        password?: string;
        indexPattern: string;
        maxRetries: number;
        requestTimeout: number;
        pingTimeout: number;
    };
}

interface ConsumerStats {
    messagesProcessed: number;
    batchesProcessed: number;
    elasticsearchWrites: number;
    errors: number;
    lastBatchTime: Date | null;
    lastElasticsearchWrite: Date | null;
    startTime: Date;
}

// Helper function para acceso seguro a process.env
function getEnvVar(key: string, defaultValue: string = ''): string {
    return process.env[key] || defaultValue;
}

function getEnvNumber(key: string, defaultValue: number): number {
    const value = process.env[key];
    const parsed = value ? parseInt(value, 10) : NaN;
    return isNaN(parsed) ? defaultValue : parsed;
}

// --- Configuración desde variables de entorno ---
const config: ConsumerConfig = {
    rabbitmq: {
        url: getEnvVar('RABBITMQ_URL', 'amqp://localhost'),
        queueName: getEnvVar('RABBITMQ_QUEUE_NAME', 'logs_queue'),
        deadLetterQueue: getEnvVar('DEAD_LETTER_QUEUE', 'logs_dlq'),
        prefetchCount: getEnvNumber('PREFETCH_COUNT', 100)
    },
    batch: {
        size: getEnvNumber('BATCH_SIZE', 50),
        timeoutMs: getEnvNumber('BATCH_TIMEOUT_MS', 5000),
        maxRetries: getEnvNumber('MAX_RETRIES', 3)
    },
    elasticsearch: {
        node: getEnvVar('ELASTICSEARCH_NODE', 'http://localhost:9200'),
        username: process.env['ELASTICSEARCH_USERNAME'],
        password: process.env['ELASTICSEARCH_PASSWORD'],
        indexPattern: getEnvVar('ELASTICSEARCH_INDEX_PATTERN', 'logs-%{+YYYY.MM.dd}'),
        maxRetries: getEnvNumber('ELASTICSEARCH_MAX_RETRIES', 3),
        requestTimeout: getEnvNumber('ELASTICSEARCH_REQUEST_TIMEOUT', 30000),
        pingTimeout: getEnvNumber('ELASTICSEARCH_PING_TIMEOUT', 3000)
    }
};

// --- Validación de configuración ---
function validateConfig(config: ConsumerConfig): void {
    if (!config.rabbitmq.url) throw new Error('RABBITMQ_URL is required');
    if (config.batch.size <= 0) throw new Error('BATCH_SIZE must be greater than 0');
    if (config.batch.timeoutMs <= 0) throw new Error('BATCH_TIMEOUT_MS must be greater than 0');
    if (!config.elasticsearch.node) throw new Error('ELASTICSEARCH_NODE is required');
    if (!config.elasticsearch.indexPattern) throw new Error('ELASTICSEARCH_INDEX_PATTERN is required');
}

// --- Servicio de Elasticsearch ---
class ElasticsearchService {
    private client: ElasticsearchClient;
    private readonly config: ConsumerConfig['elasticsearch'];

    constructor(config: ConsumerConfig['elasticsearch']) {
        this.config = config;

        // MEJORA: Usamos el tipo `ClientOptions` para una configuración segura.
        const clientConfig: ClientOptions = {
            node: config.node,
            maxRetries: config.maxRetries,
            requestTimeout: config.requestTimeout,
            pingTimeout: config.pingTimeout,
        };

        if (config.username && config.password) {
            clientConfig.auth = {
                username: config.username,
                password: config.password
            };
        }

        this.client = new ElasticsearchClient(clientConfig);
    }

    async testConnection(): Promise<void> {
        try {
            await this.client.ping();
            console.log('✅ Elasticsearch connection established');
        } catch (error) {
            console.error('❌ Elasticsearch connection failed:', error);
            throw error;
        }
    }

    async bulkIndex(logs: LogEntry[]): Promise<void> {
        if (logs.length === 0) return;

        try {
            const indexName = this.generateIndexName();

            // MEJORA: `flatMap` es más conciso para construir el body del bulk.
            const body = logs.flatMap(log => [
                {index: {_index: indexName, _id: this.generateDocumentId(log)}},
                this.enrichLogEntry(log)
            ]);

            // CAMBIO: La respuesta de la API está en `response.body`.
            const response: BulkResponse = await this.client.bulk({
                body,
                refresh: false,
                timeout: '30s'
            });

            if (response.errors) {
                // MEJORA: Filtrado de errores más seguro y específico.
                const erroredItems = response.items.filter(item => item.index?.error);
                if (erroredItems.length > 0) {
                    console.error('❌ Errores en bulk indexing:', JSON.stringify(erroredItems, null, 2));
                    throw new Error(`${erroredItems.length} documents failed to index`);
                }
            }

            console.log(`✅ Indexados ${logs.length} logs en Elasticsearch (índice: ${indexName})`);

        } catch (error) {
            console.error('❌ Error en bulk indexing:', error);
            throw error;
        }
    }

    private generateIndexName(): string {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');

        return this.config.indexPattern
            .replace('%{+YYYY.MM.dd}', `${year}.${month}.${day}`)
            .replace('%{+YYYY-MM-DD}', `${year}-${month}-${day}`);
    }

    private generateDocumentId(log: LogEntry): string {
        const timestamp = new Date(log['@timestamp']).getTime();
        const hash = this.simpleHash(`${log.service}-${log.message}-${timestamp}`);
        return `${timestamp}-${hash}`;
    }

    private simpleHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    }

    private enrichLogEntry(log: LogEntry): LogEntry {
        return {
            ...log,
            '@timestamp': new Date(log['@timestamp'] || Date.now()).toISOString(),
            '@version': '1',
            host: log.host || getEnvVar('HOSTNAME', 'unknown'),
            environment: log.environment || getEnvVar('NODE_ENV', 'development'),
            tags: log.tags || ['rabbitmq-consumer'],
            consumer: {
                name: 'rabbitmq-logs-consumer',
                version: getEnvVar('APP_VERSION', '1.0.0'),
                processed_at: new Date().toISOString()
            }
        };
    }

    async close(): Promise<void> {
        try {
            await this.client.close();
            console.log('✅ Elasticsearch client cerrado');
        } catch (error) {
            console.error('❌ Error al cerrar Elasticsearch client:', error);
        }
    }
}

// --- Clase principal del Consumer ---
class ELKLogsConsumer {
    private connection: ChannelModel | null = null;
    private channel: Channel | null = null;
    private messageBatch: BatchMessage[] = [];
    private timeoutId: NodeJS.Timeout | null = null;
    private stats: ConsumerStats;
    private isShuttingDown = false;
    private readonly config: ConsumerConfig;
    private readonly elasticsearch: ElasticsearchService;

    constructor(config: ConsumerConfig) {
        this.config = config;
        this.elasticsearch = new ElasticsearchService(config.elasticsearch);
        this.stats = {
            messagesProcessed: 0,
            batchesProcessed: 0,
            elasticsearchWrites: 0,
            errors: 0,
            lastBatchTime: null,
            lastElasticsearchWrite: null,
            startTime: new Date()
        };

        this.setupGracefulShutdown();
    }

    private setupGracefulShutdown(): void {
        const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
        signals.forEach(signal => {
            process.on(signal, async () => {
                console.log(`\n[📴] Señal ${signal} recibida. Iniciando apagado graceful...`);
                await this.shutdown();
                process.exit(0);
            });
        });

        process.on('uncaughtException', (error) => {
            console.error('❌ Excepción no capturada:', error);
            this.shutdown().then(() => process.exit(1));
        });

        process.on('unhandledRejection', (reason) => {
            console.error('❌ Promesa rechazada no manejada:', reason);
            this.shutdown().then(() => process.exit(1));
        });
    }

    async start(): Promise<void> {
        console.log('🚀 Iniciando ELK Logs Consumer...');
        console.log('📋 Configuración:', {
            rabbitmq: {
                queueName: this.config.rabbitmq.queueName,
                batchSize: this.config.batch.size,
                batchTimeoutMs: this.config.batch.timeoutMs
            },
            elasticsearch: {
                node: this.config.elasticsearch.node,
                indexPattern: this.config.elasticsearch.indexPattern
            }
        });

        try {
            await this.elasticsearch.testConnection();
            await this.connect();
            await this.setupQueues();
            await this.startConsuming();
            this.startStatsReporting();
        } catch (error) {
            console.error('❌ Error al inicializar el consumer:', error);
            await this.shutdown();
            throw error;
        }
    }

    private async connect(): Promise<void> {
        let retries = 0;
        const maxRetries = 5;
        const baseDelay = 1000;

        while (retries < maxRetries && !this.isShuttingDown) {
            try {
                this.connection = await connect(this.config.rabbitmq.url);
                this.channel = await this.connection!.createChannel();
                this.connection!.on('error', this.handleConnectionError.bind(this));
                this.connection!.on('close', this.handleConnectionClose.bind(this));

                console.log('✅ Conectado a RabbitMQ');
                return;

            } catch (error) {
                retries++;
                const delay = baseDelay * Math.pow(2, retries - 1);
                console.error(`❌ Error de conexión RabbitMQ (${retries}/${maxRetries}):`, error);

                if (retries < maxRetries) {
                    console.log(`⏳ Reintentando en ${delay}ms...`);
                    await this.delay(delay);
                } else {
                    throw new Error(`Failed to connect to RabbitMQ after ${maxRetries} attempts`);
                }
            }
        }
    }

    private async setupQueues(): Promise<void> {
        if (!this.channel) throw new Error('Channel not available');

        await this.channel.assertQueue(this.config.rabbitmq.queueName, {
            durable: true,
            arguments: {
                'x-dead-letter-exchange': '',
                'x-dead-letter-routing-key': this.config.rabbitmq.deadLetterQueue
            }
        });
        await this.channel.assertQueue(this.config.rabbitmq.deadLetterQueue, { durable: true });
        this.channel.prefetch(this.config.rabbitmq.prefetchCount);
        console.log(`📝 Colas configuradas: ${this.config.rabbitmq.queueName}, ${this.config.rabbitmq.deadLetterQueue}`);
    }

    private async startConsuming(): Promise<void> {
        if (!this.channel) throw new Error('Channel not available');
        console.log(`👂 Escuchando mensajes en "${this.config.rabbitmq.queueName}"`);
        await this.channel.consume(
            this.config.rabbitmq.queueName,
            this.handleMessage.bind(this),
            { noAck: false }
        );
    }

    private handleMessage(msg: ConsumeMessage | null): void {
        if (!msg || this.isShuttingDown) return;

        try {
            const logEntry = this.parseMessage(msg.content);

            // CAMBIO: Guardamos el mensaje completo.
            this.messageBatch.push({
                content: logEntry,
                originalMessage: msg,
                timestamp: new Date(),
            });

            this.stats.messagesProcessed++;

            // Usamos `Promise.resolve()` para no bloquear el bucle de eventos con un `await`.
            if (this.messageBatch.length >= this.config.batch.size) {
                Promise.resolve(this.processBatch());
            } else {
                this.resetBatchTimeout();
            }
        } catch (error) {
            console.error('❌ Error al procesar mensaje:', error);
            this.handleMessageError(msg, error);
        }
    }

    private parseMessage(content: Buffer): LogEntry {
        try {
            const parsed = JSON.parse(content.toString());
            if (typeof parsed.message !== 'string' || typeof parsed.level !== 'string') {
                throw new Error('Invalid log format: missing required fields message or level');
            }
            return {
                '@timestamp': new Date(parsed.timestamp || parsed['@timestamp'] || Date.now()).toISOString(),
                ...parsed
            };
        } catch (error) {
            // MEJORA: Tipamos el error como `unknown` y lo manejamos de forma segura.
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to parse message: ${errorMessage}`);
        }
    }

    // MEJORA: Función más robusta para obtener el conteo de reintentos.
    private getRetryCount(msg: ConsumeMessage): number {
        if (msg.properties.headers && 'x-death' in msg.properties.headers) {
            const xDeath = msg.properties.headers['x-death'];
            if (Array.isArray(xDeath) && xDeath.length > 0) {
                return xDeath[0].count || 0;
            }
        }
        return 0;
    }

    private resetBatchTimeout(): void {
        if (this.timeoutId) clearTimeout(this.timeoutId);
        this.timeoutId = setTimeout(() => Promise.resolve(this.processBatch()), this.config.batch.timeoutMs);
    }

    private async processBatch(): Promise<void> {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }

        if (this.messageBatch.length === 0) return;

        console.log(`⚙️ Procesando lote de ${this.messageBatch.length} mensajes`);

        const batchToProcess = this.messageBatch.slice();
        this.messageBatch = [];

        try {
            const logEntries = batchToProcess.map(msg => msg.content);
            await this.elasticsearch.bulkIndex(logEntries);

            this.ackBatch(batchToProcess);

            this.stats.batchesProcessed++;
            this.stats.elasticsearchWrites++;
            this.stats.lastBatchTime = new Date();
            this.stats.lastElasticsearchWrite = new Date();
            console.log(`✅ Lote procesado: ${batchToProcess.length} logs → Elasticsearch`);
        } catch (error) {
            console.error('❌ Error al procesar lote:', error);
            this.stats.errors++;
            this.nackBatch(batchToProcess);
        }
    }

    // CAMBIO: Lógica de ack/nack corregida.
    private ackBatch(batch: BatchMessage[]): void {
        if (!this.channel || batch.length === 0) return;
        const lastMessage = batch[batch.length - 1];
        // Hacemos ack del último mensaje con `allUpTo = true` para confirmar todo el lote.
        this.channel.ack(lastMessage.originalMessage, true);
    }

    private nackBatch(batch: BatchMessage[]): void {
        if (!this.channel || batch.length === 0) return;
        const lastMessage = batch[batch.length - 1];

        const shouldRequeue = this.getRetryCount(lastMessage.originalMessage) < this.config.batch.maxRetries;

        // Hacemos nack del último mensaje con `allUpTo = true`.
        // Si `shouldRequeue` es false, el mensaje irá a la Dead Letter Queue.
        this.channel.nack(lastMessage.originalMessage, true, shouldRequeue);

        if (!shouldRequeue) {
            console.log(`📤 ${batch.length} mensajes enviados a DLQ tras exceder reintentos.`);
        }
    }

    private handleMessageError(msg: ConsumeMessage, error: unknown): void {
        if (!this.channel) return;
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ Error en mensaje ${msg.fields.deliveryTag}:`, errorMessage);
        // Enviamos a la DLQ directamente si el mensaje es inválido (nack con requeue=false).
        this.channel.nack(msg, false, false);
        this.stats.errors++;
    }

    private handleConnectionError(error: Error): void {
        console.error('❌ Error de conexión RabbitMQ:', error.message);
        if (!this.isShuttingDown) {
            setTimeout(() => this.reconnect(), 5000);
        }
    }

    private handleConnectionClose(): void {
        console.log('🔌 Conexión RabbitMQ cerrada');
        if (!this.isShuttingDown) {
            setTimeout(() => this.reconnect(), 5000);
        }
    }

    private async reconnect(): Promise<void> {
        if (this.isShuttingDown) return;
        console.log('🔄 Intentando reconectar a RabbitMQ...');
        try {
            await this.connect();
            await this.setupQueues();
            await this.startConsuming();
        } catch (error) {
            console.error('❌ Falló la reconexión, reintentando en 10s...');
            setTimeout(() => this.reconnect(), 10000);
        }
    }

    private startStatsReporting(): void {
        const interval = setInterval(() => {
            if (this.isShuttingDown) {
                clearInterval(interval);
                return;
            }
            this.reportStats();
        }, 30000);
    }

    private reportStats(): void {
        const uptimeMinutes = Math.floor((Date.now() - this.stats.startTime.getTime()) / 60000);
        console.log('\n📊 Estadísticas ELK Consumer:');
        console.log(`├── Mensajes procesados: ${this.stats.messagesProcessed}`);
        console.log(`├── Lotes procesados: ${this.stats.batchesProcessed}`);
        console.log(`├── Errores: ${this.stats.errors}`);
        console.log(`├── Último lote: ${this.stats.lastBatchTime?.toLocaleTimeString() || 'N/A'}`);
        console.log(`├── Uptime: ${uptimeMinutes} minutos`);
        console.log(`└── Buffer actual: ${this.messageBatch.length} mensajes\n`);
    }

    private async shutdown(): Promise<void> {
        if (this.isShuttingDown) return;
        console.log('🛑 Iniciando apagado graceful...');
        this.isShuttingDown = true;

        if (this.messageBatch.length > 0) {
            console.log(`📦 Procesando últimos ${this.messageBatch.length} mensajes...`);
            await this.processBatch();
        }

        if (this.timeoutId) clearTimeout(this.timeoutId);

        try {
            if (this.channel) await this.channel.close();
            console.log('✅ Canal RabbitMQ cerrado');
            if (this.connection) await this.connection.close();
            console.log('✅ Conexión RabbitMQ cerrada');
            await this.elasticsearch.close();
        } catch (error) {
            console.error('❌ Error al cerrar conexiones:', error);
        }

        this.reportStats();
        console.log('👋 Apagado completado');
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// --- Función principal ---
async function main(): Promise<void> {
    try {
        validateConfig(config);
        const consumer = new ELKLogsConsumer(config);
        await consumer.start();
        console.log('🎯 ELK Consumer iniciado. Presiona Ctrl+C para detener.');
    } catch (error) {
        console.error('💥 Error fatal al iniciar el consumer:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('💥 Error no manejado en main:', error);
        process.exit(1);
    });
}

export { ELKLogsConsumer, ElasticsearchService };
export type { ConsumerConfig };