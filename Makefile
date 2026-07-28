.PHONY: build test

build:
	cd web && npm ci && npm run build
	mkdir -p bin
	go build -trimpath -o bin/euphony ./cmd/euphony

test:
	go test ./...
	cd web && npm test -- --run && npm run typecheck
