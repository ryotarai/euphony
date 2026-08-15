//go:build windows

package server

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	browseForFolderReturnOnlyFileSystemDirs = 0x0001
	browseForFolderNewDialogStyle           = 0x0040
	browseForFolderNoNewFolderButton        = 0x0200
)

type browseInfo struct {
	hwndOwner      windows.Handle
	pidlRoot       uintptr
	pszDisplayName *uint16
	lpszTitle      *uint16
	ulFlags        uint32
	lpfn           uintptr
	lParam         uintptr
	iImage         int32
}

var (
	shell32              = windows.NewLazySystemDLL("shell32.dll")
	shBrowseForFolderW   = shell32.NewProc("SHBrowseForFolderW")
	shGetPathFromIDListW = shell32.NewProc("SHGetPathFromIDListW")
)

func pickDirectoryNativeWindows(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED|windows.COINIT_DISABLE_OLE1DDE); err != nil &&
		err != windows.Errno(1) {
		return "", fmt.Errorf("initialize Windows folder picker: %w", err)
	}
	defer windows.CoUninitialize()

	title, err := windows.UTF16PtrFromString("Choose project directory")
	if err != nil {
		return "", fmt.Errorf("encode Windows folder picker title: %w", err)
	}
	var displayName [windows.MAX_PATH]uint16
	info := browseInfo{
		pszDisplayName: &displayName[0],
		lpszTitle:      title,
		ulFlags: browseForFolderReturnOnlyFileSystemDirs |
			browseForFolderNewDialogStyle |
			browseForFolderNoNewFolderButton,
	}

	pidl, _, _ := shBrowseForFolderW.Call(uintptr(unsafe.Pointer(&info)))
	if pidl == 0 {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		return "", errDirectoryPickerCanceled
	}
	defer windows.CoTaskMemFree(unsafe.Pointer(pidl))

	var path [windows.MAX_PATH]uint16
	result, _, callErr := shGetPathFromIDListW.Call(
		pidl,
		uintptr(unsafe.Pointer(&path[0])),
	)
	if result == 0 {
		if callErr != nil {
			return "", fmt.Errorf("get picked directory path: %w", callErr)
		}
		return "", errors.New("picked directory has no filesystem path")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return windows.UTF16ToString(path[:]), nil
}
