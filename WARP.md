# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Service Overview

This is a TypeScript-based logs service that consumes log messages from RabbitMQ and stores them in Elasticsearch. It's part of a larger microservices video application backend.

### Architecture

- **Message Processing**: RabbitMQ consumer with batch processing and dead letter queue support
- **Storage**: Elasticsearch with index templates, ILM policies, and time-based indices
- **Core Components**:
  - `ELKLogsConsumer`: Main consumer class handling RabbitMQ message processing
  - `ElasticsearchService`: Elasticsearch client with bulk indexing and connection management
  - Batch processing with configurable size and timeout
  - Graceful shutdown with message completion
  - Comprehensive error handling and retry logic

## Development Commands

### Setup & Dependencies
```bash
# Install dependencies
make install
# or npm install

# Setup complete environment (Docker + ES templates)
make setup
```

### Build & Run
```bash
# Development mode with auto-reload
make dev
# or npm run dev

# Build TypeScript
make build
# or npm run build

# Production start
make start
# or npm run start

# Watch mode (compile on changes)
npm run watch
```

### Docker Infrastructure
```bash
# Start all infrastructure services
make docker-up

# Stop all services
make docker-down

# View all service logs
make logs

# View specific service logs
make logs-es      # Elasticsearch
make logs-kibana  # Kibana
make logs-rabbitmq # RabbitMQ

# Check service status
make status

# Monitor metrics in real-time
make monitor
```

### Testing & Quality
```bash
# Run tests
make test
# or npm test

# Lint code
npm run lint

# Clean build artifacts
make clean
# or npm run clean
```

## Environment Configuration

Key environment variables (see parent directory's `.env.example`):
- `RABBITMQ_URL`: RabbitMQ connection URL (default: amqp://localhost)
- `RABBITMQ_QUEUE_NAME`: Queue name for consuming logs (default: logs_queue)
- `ELASTICSEARCH_NODE`: Elasticsearch connection URL (default: http://localhost:9200)
- `BATCH_SIZE`: Number of messages to batch before sending to ES (default: 50)
- `BATCH_TIMEOUT_MS`: Max time to wait for batch completion (default: 5000ms)

## Service URLs (when using Docker)
- Elasticsearch: http://localhost:9200
- Kibana: http://localhost:5601  
- RabbitMQ Management: http://localhost:15672 (admin/admin123)

## Key Files & Scripts

- `src/index.ts`: Main service implementation with consumer and ES service classes
- `scripts/wait-for-elasticsearch.js`: Health check utility for ES availability
- `scripts/setup-index-templates.js`: ES index templates and ILM policy setup
- `Makefile`: Comprehensive build and infrastructure management commands

## Data Flow

1. **Message Consumption**: Service consumes JSON log messages from configured RabbitMQ queue
2. **Batch Processing**: Messages are batched for efficient Elasticsearch indexing
3. **Enrichment**: Logs are enriched with consumer metadata and standardized timestamps  
4. **Storage**: Bulk indexed to daily Elasticsearch indices with pattern `logs-YYYY.MM.dd`
5. **Error Handling**: Failed messages sent to dead letter queue after max retries

## TypeScript Configuration

- **Target**: ES2020 with CommonJS modules for Node.js compatibility
- **Strict mode**: Enabled with comprehensive type checking
- **Build output**: `dist/` directory with source maps and declarations
- **Development**: Uses ts-node for direct execution without compilation
