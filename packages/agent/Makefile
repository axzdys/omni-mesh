# OmniMesh agent — zero-dependency (pure Go stdlib) cross-platform builds
GO ?= go
DIST := dist
VERSION ?= 1.0.0

.PHONY: all clean test vet build-linux-amd64 build-linux-arm64 build-windows-amd64

all: build-linux-amd64 build-linux-arm64 build-windows-amd64

build-linux-amd64:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o $(DIST)/omni-agent-linux-amd64 ./cmd/omni-agent

build-linux-arm64:
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o $(DIST)/omni-agent-linux-arm64 ./cmd/omni-agent

build-windows-amd64:
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o $(DIST)/omni-agent-windows-amd64.exe ./cmd/omni-agent

test:
	$(GO) vet ./...
	$(GO) test ./...

clean:
	rm -rf $(DIST)
