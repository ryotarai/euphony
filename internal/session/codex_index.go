package session

import (
	"bufio"
	"encoding/json"
	"os"
)

func loadCodexSessionTitles(path string) (map[string]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	titles := make(map[string]string)
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var item struct {
			ID         string `json:"id"`
			ThreadName string `json:"thread_name"`
		}
		if json.Unmarshal(scanner.Bytes(), &item) == nil && item.ID != "" && item.ThreadName != "" {
			titles[item.ID] = item.ThreadName
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return titles, nil
}
