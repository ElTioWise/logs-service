.PHONY: help install build start dev clean test docker-up docker-down logs setup

# Variables
NODE_ENV ?= development
COMPOSE_FILE = docker-compose.yml

# Colores para output
RED := \033[0;31m
GREEN := \033[0;32m
YELLOW := \033[1;33m
BLUE := \033[0;34m
NC := \033[0m # No Color

## help: Mostrar esta ayuda
help:
	@echo "$(BLUE)Comandos disponibles:$(NC)"
	@echo "$(GREEN)make install$(NC)     - Instalar dependencias"
	@echo "$(GREEN)make build$(NC)       - Compilar TypeScript"
	@echo "$(GREEN)make start$(NC)       - Iniciar aplicación (producción)"
	@echo "$(GREEN)make dev$(NC)         - Iniciar en modo desarrollo"
	@echo "$(GREEN)make clean$(NC)       - Limpiar archivos compilados"
	@echo "$(GREEN)make test$(NC)        - Ejecutar tests"
	@echo "$(GREEN)make docker-up$(NC)   - Levantar servicios Docker"
	@echo "$(GREEN)make docker-down$(NC) - Bajar servicios Docker"
	@echo "$(GREEN)make setup$(NC)       - Setup completo (Docker + Templates)"
	@echo "$(GREEN)make logs$(NC)        - Ver logs de Docker Compose"
	@echo "$(GREEN)make status$(NC)      - Ver estado de servicios"

## install: Instalar todas las dependencias
install:
	@echo "$(YELLOW)Instalando dependencias...$(NC)"
	npm install
	@echo "$(GREEN)✅ Dependencias instaladas$(NC)"

## build: Compilar TypeScript
build: clean
	@echo "$(YELLOW)Compilando TypeScript...$(NC)"
	npm run build
	@echo "$(GREEN)✅ Compilación completada$(NC)"

## start: Iniciar aplicación en modo producción
start: build
	@echo "$(YELLOW)Iniciando aplicación...$(NC)"
	NODE_ENV=production npm run start

## dev: Iniciar en modo desarrollo con auto-reload
dev:
	@echo "$(YELLOW)Iniciando en modo desarrollo...$(NC)"
	npm run dev:watch

## clean: Limpiar archivos compilados
clean:
	@echo "$(YELLOW)Limpiando archivos compilados...$(NC)"
	npm run clean
	@echo "$(GREEN)✅ Archivos limpiados$(NC)"

## test: Ejecutar tests
test:
	@echo "$(YELLOW)Ejecutando tests...$(NC)"
	npm test

## docker-up: Levantar todos los servicios Docker
docker-up:
	@echo "$(YELLOW)Levantando servicios Docker...$(NC)"
	docker-compose -f $(COMPOSE_FILE) up -d
	@echo "$(GREEN)✅ Servicios Docker iniciados$(NC)"
	@echo "$(BLUE)Servicios disponibles:$(NC)"
	@echo "  - Elasticsearch: http://localhost:9200"
	@echo "  - Kibana: http://localhost:5601"
	@echo "  - RabbitMQ Management: http://localhost:15672 (admin/admin123)"

## docker-down: Bajar todos los servicios Docker
docker-down:
	@echo "$(YELLOW)Bajando servicios Docker...$(NC)"
	docker-compose -f $(COMPOSE_FILE) down -v
	@echo "$(GREEN)✅ Servicios Docker detenidos$(NC)"

## setup: Setup completo del ambiente
setup: docker-up wait-elasticsearch setup-templates
	@echo "$(GREEN)🎉 Setup completo terminado!$(NC)"

## wait-elasticsearch: Esperar que Elasticsearch esté disponible
wait-elasticsearch:
	@echo "$(YELLOW)Esperando que Elasticsearch esté disponible...$(NC)"
	node scripts/wait-for-elasticsearch.js

## setup-templates: Configurar plantillas de Elasticsearch
setup-templates:
	@echo "$(YELLOW)Configurando plantillas de Elasticsearch...$(NC)"
	node scripts/setup-index-templates.js

## logs: Ver logs de todos los servicios
logs:
	docker-compose -f $(COMPOSE_FILE) logs -f

## logs-es: Ver logs específicos de Elasticsearch
logs-es:
	docker-compose -f $(COMPOSE_FILE) logs -f elasticsearch

## logs-kibana: Ver logs específicos de Kibana
logs-kibana:
	docker-compose -f $(COMPOSE_FILE) logs -f kibana

## logs-rabbitmq: Ver logs específicos de RabbitMQ
logs-rabbitmq:
	docker-compose -f $(COMPOSE_FILE) logs -f rabbitmq

## status: Ver estado de todos los servicios
status:
	@echo "$(BLUE)Estado de servicios Docker:$(NC)"
	docker-compose -f $(COMPOSE_FILE) ps
	@echo ""
	@echo "$(BLUE)Verificación de conectividad:$(NC)"
	@echo -n "Elasticsearch: "
	@curl -s http://localhost:9200/_cluster/health | jq -r '.status' 2>/dev/null || echo "$(RED)No disponible$(NC)"
	@echo -n "Kibana: "
	@curl -s http://localhost:5601/api/status | jq -r '.status.overall.state' 2>/dev/null || echo "$(RED)No disponible$(NC)"
	@echo -n "RabbitMQ: "
	@curl -s -u admin:admin123 http://localhost:15672/api/overview | jq -r '.rabbitmq_version' 2>/dev/null || echo "$(RED)No disponible$(NC)"

## restart: Reiniciar un servicio específico
restart:
	@read -p "Ingresa el nombre del servicio a reiniciar: " service; \
	docker-compose -f $(COMPOSE_FILE) restart $$service

## shell-es: Abrir shell en contenedor Elasticsearch
shell-es:
	docker-compose -f $(COMPOSE_FILE) exec elasticsearch bash

## shell-kibana: Abrir shell en contenedor Kibana
shell-kibana:
	docker-compose -f $(COMPOSE_FILE) exec kibana bash

## backup-es: Crear backup de Elasticsearch
backup-es:
	@echo "$(YELLOW)Creando backup de Elasticsearch...$(NC)"
	curl -X PUT "localhost:9200/_snapshot/backup_repository" -H 'Content-Type: application/json' -d'{"type": "fs","settings": {"location": "/usr/share/elasticsearch/backups"}}'
	curl -X PUT "localhost:9200/_snapshot/backup_repository/snapshot_$(shell date +%Y%m%d_%H%M%S)" -H 'Content-Type: application/json' -d'{"indices": "logs-*"}'
	@echo "$(GREEN)✅ Backup creado$(NC)"

## monitor: Mostrar métricas en tiempo real
monitor:
	@echo "$(BLUE)Monitoreando métricas (Ctrl+C para salir):$(NC)"
	@while true; do \
		echo "=========================================="; \
		echo "Elasticsearch Health:"; \
		curl -s http://localhost:9200/_cluster/health | jq '.'; \
		echo ""; \
		echo "RabbitMQ Overview:"; \
		curl -s -u admin:admin123 http://localhost:15672/api/overview | jq '.queue_totals, .message_stats'; \
		echo ""; \
		sleep 10; \
	done

# Configuración por defecto
.DEFAULT_GOAL := help