.PHONY: build dev test

dev:
	./scripts/dev.sh

build:
	cd web && npm ci && npm run build
	mkdir -p bin
	go build -trimpath -o bin/euphony ./cmd/euphony

test:
	bash scripts/dev_test.sh
	go test ./...
	cd web && npm test -- --run && npm run typecheck
