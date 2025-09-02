const { Client } = require('@elastic/elasticsearch');

async function waitForElasticsearch() {
    const client = new Client({
        node: process.env.ELASTICSEARCH_NODE || 'http://localhost:9200',
        requestTimeout: 60000,
        pingTimeout: 10000
    });

    const maxAttempts = 30;
    let attempts = 0;

    console.log('⏳ Esperando que Elasticsearch esté disponible...');

    while (attempts < maxAttempts) {
        try {
            const response = await client.ping();
            if (response.statusCode === 200) {
                console.log('✅ Elasticsearch está disponible!');

                // Verificar la salud del cluster
                const health = await client.cluster.health();
                console.log(`📊 Estado del cluster: ${health.body.status}`);

                return;
            }
        } catch (error) {
            attempts++;
            console.log(`❌ Intento ${attempts}/${maxAttempts} fallido. Reintentando en 2 segundos...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    throw new Error(`No se pudo conectar a Elasticsearch después de ${maxAttempts} intentos`);
}