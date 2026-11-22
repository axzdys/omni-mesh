# OmniMesh root Makefile — agent cross-platform builds are delegated to packages/agent
.PHONY: all agent test typecheck build-dashboard

all: agent build-dashboard

agent:
	cd packages/agent && $(MAKE) all

test:
	cd packages/agent && $(MAKE) test
	cd packages/control-plane && pnpm run test

typecheck:
	pnpm run typecheck

build-dashboard:
	pnpm --filter @omni/dashboard run build
