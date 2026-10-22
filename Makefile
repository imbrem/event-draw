.PHONY: bootstrap doctor dev build test

bootstrap:
	HOMEBREW_NO_AUTO_UPDATE=1 brew bundle --file=Brewfile --no-upgrade

doctor:
	@bash scripts/doctor.sh

dev:
	pnpm dev

build:
	pnpm build

test:
	pnpm test
