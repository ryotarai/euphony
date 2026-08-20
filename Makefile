.PHONY: build dev test test-e2e macos-app test-macos windows-amd64 release-build release-test

dev:
	./scripts/dev.sh

build:
	cd web && npm ci && npm run build
	mkdir -p bin
	go build -trimpath -o bin/euphony ./cmd/euphony

windows-amd64:
	cd web && npm ci && npm run build
	mkdir -p bin
	GOOS=windows GOARCH=amd64 go build -trimpath -o bin/euphony-windows-amd64.exe ./cmd/euphony

test:
	bash scripts/dev_test.sh
	bash scripts/build_release_test.sh
	go test ./...
	cd web && npm test -- --run && npm run typecheck
	$(MAKE) test-e2e

test-e2e:
	cd web && npx playwright test --workers=1

macos-app:
	./scripts/build_macos_app.sh

test-macos:
	./scripts/test_macos_app.sh

release-build:
	./scripts/build_release.sh

release-test:
	bash scripts/build_release_test.sh
