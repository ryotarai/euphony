package main

import (
	"log"
	"net/http"
	"os"

	"github.com/ryotarai/euphony/internal/server"
)

func main() {
	srv, err := server.New(server.Config{
		Token: os.Getenv("EUPHONY_TOKEN"),
		Shell: os.Getenv("SHELL"),
	})
	if err != nil {
		log.Fatal(err)
	}

	address := os.Getenv("EUPHONY_ADDR")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	log.Printf("Euphony listening on http://%s", address)
	log.Fatal(http.ListenAndServe(address, srv.Handler()))
}
