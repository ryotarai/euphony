package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ryotarai/euphony/internal/server"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	address := os.Getenv("EUPHONY_ADDR")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	srv, err := server.New(server.Config{
		Token:   os.Getenv("EUPHONY_TOKEN"),
		Shell:   os.Getenv("SHELL"),
		HookURL: "http://" + address + "/api/hooks/terminal",
	})
	if err != nil {
		log.Fatal(err)
	}

	log.Printf("Euphony listening on http://%s", address)
	httpServer := &http.Server{
		Addr:              address,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	result := make(chan error, 1)
	go func() {
		result <- httpServer.ListenAndServe()
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	select {
	case err := <-result:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-signals:
		log.Print("Shutting down Euphony")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdownErr := httpServer.Shutdown(ctx)
	sessionErr := srv.Close(ctx)
	if shutdownErr != nil {
		return shutdownErr
	}
	return sessionErr
}
