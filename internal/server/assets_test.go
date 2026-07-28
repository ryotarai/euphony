package server

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAssetsServeFilesAndSPAFallback(t *testing.T) {
	assets := testAssets(t, map[string]string{
		"dist/index.html":        "<main>Euphony app</main>",
		"dist/assets/app.js":     "console.log('euphony')",
		"dist/assets/styles.css": "body{background:#111417}",
	})
	handler, err := newStaticHandler(assets)
	if err != nil {
		t.Fatalf("newStaticHandler() error = %v", err)
	}

	tests := []struct {
		path        string
		wantStatus  int
		wantType    string
		wantContent string
	}{
		{path: "/", wantStatus: 200, wantType: "text/html", wantContent: "Euphony app"},
		{path: "/workspace/session", wantStatus: 200, wantType: "text/html", wantContent: "Euphony app"},
		{path: "/assets/app.js", wantStatus: 200, wantType: "text/javascript", wantContent: "console.log"},
		{path: "/assets/missing.js", wantStatus: 404},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, test.wantStatus, response.Body.String())
			}
			if test.wantType != "" && !strings.HasPrefix(response.Header().Get("Content-Type"), test.wantType) {
				t.Fatalf("Content-Type = %q, want prefix %q", response.Header().Get("Content-Type"), test.wantType)
			}
			if test.wantContent != "" && !strings.Contains(response.Body.String(), test.wantContent) {
				t.Fatalf("body = %q, want %q", response.Body.String(), test.wantContent)
			}
		})
	}
}

func TestAssetsRejectMissingIndex(t *testing.T) {
	_, err := newStaticHandler(testAssets(t, map[string]string{"dist/.keep": ""}))
	if err == nil {
		t.Fatal("newStaticHandler() error = nil, want missing index error")
	}
}

func testAssets(t *testing.T, files map[string]string) fs.FS {
	t.Helper()
	root := t.TempDir()
	for name, content := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("MkdirAll(%q): %v", path, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("WriteFile(%q): %v", path, err)
		}
	}
	return os.DirFS(root)
}
