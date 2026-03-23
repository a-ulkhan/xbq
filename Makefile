.PHONY: install uninstall build clean

build:
	npm install
	npm run build

install: build
	npm link
	@echo ""
	@echo "✓ 'xbq' is now available globally"
	@echo "  Run 'xbq init' to configure your main repo"

uninstall:
	npm unlink -g xbq
	@echo "✓ 'xbq' removed"

clean:
	rm -rf dist node_modules
