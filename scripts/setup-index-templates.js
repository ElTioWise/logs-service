async function setupIndexTemplates() {
    const { Client } = require('@elastic/elasticsearch');

    const client = new Client({
        node: process.env.ELASTICSEARCH_NODE || 'http://localhost:9200'
    });

    console.log('📝 Configurando plantillas de índices...');

    // Template para logs
    const logsTemplate = {
        index_patterns: ["logs-*"],
        template: {
            settings: {
                number_of_shards: 1,
                number_of_replicas: 0,
                "index.refresh_interval": "5s"
            },
            mappings: {
                properties: {
                    "@timestamp": {
                        type: "date"
                    },
                    "@version": {
                        type: "keyword"
                    },
                    level: {
                        type: "keyword"
                    },
                    message: {
                        type: "text",
                        analyzer: "standard"
                    },
                    service: {
                        type: "keyword"
                    },
                    environment: {
                        type: "keyword"
                    },
                    host: {
                        type: "keyword"
                    },
                    tags: {
                        type: "keyword"
                    },
                    consumer: {
                        properties: {
                            name: {
                                type: "keyword"
                            },
                            version: {
                                type: "keyword"
                            },
                            processed_at: {
                                type: "date"
                            }
                        }
                    },
                    fields: {
                        type: "object",
                        dynamic: true
                    }
                }
            }
        }
    };

    try {
        await client.indices.putIndexTemplate({
            name: 'logs-template',
            body: logsTemplate
        });
        console.log('✅ Template "logs-template" creado');

        // ILM Policy para rotación de índices
        const ilmPolicy = {
            policy: {
                phases: {
                    hot: {
                        actions: {
                            rollover: {
                                max_size: "10GB",
                                max_age: "1d"
                            }
                        }
                    },
                    warm: {
                        min_age: "1d",
                        actions: {
                            allocate: {
                                number_of_replicas: 0
                            }
                        }
                    },
                    delete: {
                        min_age: "7d"
                    }
                }
            }
        };

        await client.ilm.putLifecycle({
            name: 'logs-policy',
            body: ilmPolicy
        });
        console.log('✅ ILM Policy "logs-policy" creada');

        // Crear un alias para facilitar las consultas
        await client.indices.putAlias({
            index: 'logs-*',
            name: 'all-logs'
        });
        console.log('✅ Alias "all-logs" creado');

        console.log('🎉 Configuración de Elasticsearch completada!');

    } catch (error) {
        console.error('❌ Error configurando Elasticsearch:', error);
        throw error;
    }
}

// Determinar qué función ejecutar según el nombre del archivo
if (require.main === module) {
    const scriptName = process.argv[1];

    if (scriptName.includes('wait-for-elasticsearch')) {
        waitForElasticsearch().catch(error => {
            console.error(error);
            process.exit(1);
        });
    } else if (scriptName.includes('setup-index-templates')) {
        setupIndexTemplates().catch(error => {
            console.error(error);
            process.exit(1);
        });
    }
}

module.exports = { waitForElasticsearch, setupIndexTemplates };