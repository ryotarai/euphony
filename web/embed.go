package web

import "embed"

// Assets contains the production frontend when it has been built.
//
//go:embed all:dist
var Assets embed.FS

//go:embed fallback.html
var FallbackHTML []byte
