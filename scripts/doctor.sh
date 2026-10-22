#!/bin/bash
set -u

result=0

check_tool() {
    local tool="$1"
    shift
    if command -v "$tool" >/dev/null 2>&1; then
        printf '\n%s: %s\n' "$tool" "$(command -v "$tool")"
        if ! "$tool" "$@"; then
            result=1
        fi
    else
        printf '\nMissing tool: %s\n' "$tool"
        result=1
    fi
}

sw_vers
check_tool brew --version
check_tool xcodegen --version
check_tool xcbeautify --version
check_tool mas version
check_tool sqlite3 --version

printf '\nActive developer directory: '
xcode-select -p || result=1
if [ -n "${DEVELOPER_DIR:-}" ]; then
    printf 'Developer directory override: %s\n' "$DEVELOPER_DIR"
fi

if xcode_version="$(xcodebuild -version 2>&1)"; then
    printf '\n%s\n' "$xcode_version"
    xcodebuild -showsdks || result=1
    printf '\nSimulator runtimes:\n'
    xcrun simctl list runtimes || result=1
    printf '\nDevice CLI: '
    xcrun --find devicectl || result=1
else
    printf '\nFull Xcode is not ready:\n%s\n' "$xcode_version"
    printf 'Install Xcode, complete its first-launch setup, and select its developer directory.\n'
    result=1
fi

exit "$result"
