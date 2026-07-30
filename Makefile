.PHONY: build dev test test-cli

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
	$(MAKE) test-cli

test-cli:
	cd web && npx playwright test e2e/automation.spec.ts --workers=1
