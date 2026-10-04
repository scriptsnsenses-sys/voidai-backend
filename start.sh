#!/bin/bash

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}Starting VOIAI Backend (Not affilated with VoidAI)...${NC}"

if [ ! -f .env ]; then
    echo -e "${RED}Error: .env file not found!${NC}"
    echo "Please create .env file with production values."
    exit 1
fi

export $(cat .env | grep -v '^#' | xargs)

echo -e "${YELLOW}Building application image...${NC}"
docker build -t voidai-app:latest .

echo -e "${GREEN}Starting services...${NC}"
docker compose up -d --build --force-recreate --remove-orphans

echo -e "${GREEN}Services started successfully!${NC}"
echo -e "${BLUE}Application: http://localhost:8080${NC}"
echo -e "${BLUE}Commands:${NC}"
echo "  View logs: docker compose logs app -f"
echo "  Stop all: docker compose down"
echo "  Restart: docker compose restart"