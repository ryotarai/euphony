.PHONY: build dev test test-cli test-e2e macos-app test-macos

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
	$(MAKE) test-e2e

test-cli:
	cd web && npx playwright test e2e/automation.spec.ts --workers=1

test-e2e:
	cd web && npx playwright test --workers=1

macos-app:
	./scripts/build_macos_app.sh

test-macos:
	./scripts/test_macos_app.sh
