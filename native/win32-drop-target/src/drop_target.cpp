#include "drop_target.h"
#include <commctrl.h>

// ============================================================================
// Approach: WM_DROPFILES via window subclassing
//
// OLE RegisterDragDrop does not work in Electron 40+ — Chromium's internal
// Aura windowing system intercepts OLE drag-drop before our IDropTarget is
// ever invoked. Instead, we use the simpler Shell DragAcceptFiles mechanism:
//
//   1. ChangeWindowMessageFilterEx — allow WM_DROPFILES through UIPI
//   2. DragAcceptFiles(hwnd, TRUE) — tell Shell this window accepts files
//   3. SetWindowSubclass — intercept WM_DROPFILES in the window proc
//
// Trade-off: no drag-enter/leave/over feedback (no overlay during hover).
// The overlay will be triggered on the actual drop instead.
// ============================================================================

// Global state
static Napi::ThreadSafeFunction globalOnDropTsfn;
static HWND globalSubclassedHwnd = nullptr;
static bool tsfnInitialized = false;

// Image extension classification
static bool IsImageExtension(const std::wstring& extension) {
    static const std::wstring imageExtensions[] = {
        L".png", L".jpg", L".jpeg", L".gif", L".bmp",
        L".webp", L".svg", L".ico", L".tiff", L".tif"
    };
    for (const auto& imageExt : imageExtensions) {
        if (extension == imageExt) {
            return true;
        }
    }
    return false;
}

static std::wstring GetLowerExtension(const std::wstring& filePath) {
    size_t dotPos = filePath.rfind(L'.');
    if (dotPos == std::wstring::npos) {
        return L"";
    }
    std::wstring extension = filePath.substr(dotPos);
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](wchar_t character) { return static_cast<wchar_t>(towlower(character)); });
    return extension;
}

static std::string WideToUtf8(const std::wstring& wide) {
    if (wide.empty()) {
        return "";
    }
    int bufferSize = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(),
                                          static_cast<int>(wide.size()),
                                          nullptr, 0, nullptr, nullptr);
    if (bufferSize <= 0) {
        return "";
    }
    std::string utf8(bufferSize, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.c_str(),
                        static_cast<int>(wide.size()),
                        &utf8[0], bufferSize, nullptr, nullptr);
    return utf8;
}

// Window subclass procedure — intercepts WM_DROPFILES
static LRESULT CALLBACK DropSubclassProc(
    HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam,
    UINT_PTR subclassId, DWORD_PTR refData) {

    if (msg == WM_DROPFILES && tsfnInitialized) {
        HDROP hDrop = reinterpret_cast<HDROP>(wParam);
        UINT fileCount = DragQueryFileW(hDrop, 0xFFFFFFFF, nullptr, 0);

        auto* filePaths = new std::vector<std::string>();
        filePaths->reserve(fileCount);

        for (UINT index = 0; index < fileCount; ++index) {
            UINT pathLength = DragQueryFileW(hDrop, index, nullptr, 0);
            if (pathLength == 0) {
                continue;
            }

            std::wstring widePath(pathLength + 1, L'\0');
            DragQueryFileW(hDrop, index, &widePath[0], pathLength + 1);
            widePath.resize(pathLength);

            std::string utf8Path = WideToUtf8(widePath);
            if (!utf8Path.empty()) {
                filePaths->push_back(utf8Path);
            }
        }

        DragFinish(hDrop);

        // Fire onDrop callback via ThreadSafeFunction
        auto status = globalOnDropTsfn.NonBlockingCall(filePaths,
            [](Napi::Env env, Napi::Function jsCallback, std::vector<std::string>* paths) {
                Napi::Array array = Napi::Array::New(env, paths->size());
                for (size_t index = 0; index < paths->size(); ++index) {
                    array.Set(static_cast<uint32_t>(index),
                              Napi::String::New(env, (*paths)[index]));
                }
                jsCallback.Call({array});
                delete paths;
            });
        if (status != napi_ok) {
            delete filePaths;
        }

        return 0;  // Handled — don't pass to Chromium
    }

    return DefSubclassProc(hwnd, msg, wParam, lParam);
}

// ============================================================================
// NAPI Module
// ============================================================================

// WM_COPYGLOBALDATA — needed for cross-process drag-drop through UIPI
#ifndef WM_COPYGLOBALDATA
#define WM_COPYGLOBALDATA 0x0049
#endif

/**
 * registerDropTarget(hwndBuffer, callbacks) -> { success, hwnd, error? }
 *
 * Uses DragAcceptFiles + window subclassing instead of OLE RegisterDragDrop.
 */
static Napi::Value RegisterDropTarget(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object result = Napi::Object::New(env);

    // Validate arguments
    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsObject()) {
        result.Set("success", Napi::Boolean::New(env, false));
        result.Set("hwnd", Napi::String::New(env, "0x0"));
        result.Set("error", Napi::String::New(env, "Invalid arguments: expected (Buffer, Object)"));
        return result;
    }

    Napi::Buffer<char> hwndBuffer = info[0].As<Napi::Buffer<char>>();
    if (hwndBuffer.Length() < sizeof(HWND)) {
        result.Set("success", Napi::Boolean::New(env, false));
        result.Set("hwnd", Napi::String::New(env, "0x0"));
        result.Set("error", Napi::String::New(env, "HWND buffer too small"));
        return result;
    }

    HWND hwnd = *reinterpret_cast<HWND*>(hwndBuffer.Data());

    Napi::Object callbacks = info[1].As<Napi::Object>();
    if (!callbacks.Has("onDrop") || !callbacks.Get("onDrop").IsFunction()) {
        result.Set("success", Napi::Boolean::New(env, false));
        result.Set("hwnd", Napi::String::New(env, "0x0"));
        result.Set("error", Napi::String::New(env, "Callbacks object must have onDrop function"));
        return result;
    }

    // Create ThreadSafeFunction for the drop callback
    globalOnDropTsfn = Napi::ThreadSafeFunction::New(
        env, callbacks.Get("onDrop").As<Napi::Function>(),
        "onDrop", 0, 1);
    tsfnInitialized = true;

    // Step 1: Revoke ALL existing OLE drop targets so they can't intercept the drag.
    // Chromium's broken IDropTarget returns DROPEFFECT_NONE, which blocks drops.
    // OLE drag takes priority over WM_DROPFILES, so we must remove it first.
    OleInitialize(nullptr);
    RevokeDragDrop(hwnd);

    // Also revoke on all child HWNDs
    EnumChildWindows(hwnd, [](HWND childHwnd, LPARAM) -> BOOL {
        RevokeDragDrop(childHwnd);
        return TRUE;  // Continue enumeration
    }, 0);

    OleUninitialize();

    // Step 2: Allow WM_DROPFILES through UIPI (User Interface Privilege Isolation)
    ChangeWindowMessageFilterEx(hwnd, WM_DROPFILES, MSGFLT_ALLOW, nullptr);
    ChangeWindowMessageFilterEx(hwnd, WM_COPYGLOBALDATA, MSGFLT_ALLOW, nullptr);

    // Step 3: Tell the Shell this window accepts file drops
    // With no OLE IDropTarget registered, Windows falls back to WM_DROPFILES
    DragAcceptFiles(hwnd, TRUE);

    // Subclass the window to intercept WM_DROPFILES before Chromium can handle it
    BOOL subclassOk = SetWindowSubclass(hwnd, DropSubclassProc, 1, 0);
    if (!subclassOk) {
        tsfnInitialized = false;
        globalOnDropTsfn.Release();

        result.Set("success", Napi::Boolean::New(env, false));
        char hwndStr[32];
        snprintf(hwndStr, sizeof(hwndStr), "0x%p", static_cast<void*>(hwnd));
        result.Set("hwnd", Napi::String::New(env, hwndStr));
        result.Set("error", Napi::String::New(env, "SetWindowSubclass failed"));
        return result;
    }

    globalSubclassedHwnd = hwnd;

    char hwndStr[32];
    snprintf(hwndStr, sizeof(hwndStr), "0x%p", static_cast<void*>(hwnd));
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("hwnd", Napi::String::New(env, hwndStr));
    result.Set("registeredOnChild", Napi::Boolean::New(env, false));
    result.Set("revokedCount", Napi::Number::New(env, 0));
    return result;
}

/**
 * unregisterDropTarget(hwndBuffer) -> void
 */
static Napi::Value UnregisterDropTarget(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (globalSubclassedHwnd) {
        RemoveWindowSubclass(globalSubclassedHwnd, DropSubclassProc, 1);
        DragAcceptFiles(globalSubclassedHwnd, FALSE);
        globalSubclassedHwnd = nullptr;
    }

    if (tsfnInitialized) {
        globalOnDropTsfn.Release();
        tsfnInitialized = false;
    }

    return env.Undefined();
}

// ============================================================================
// Module initialization
// ============================================================================

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("registerDropTarget",
                Napi::Function::New(env, RegisterDropTarget, "registerDropTarget"));
    exports.Set("unregisterDropTarget",
                Napi::Function::New(env, UnregisterDropTarget, "unregisterDropTarget"));
    return exports;
}

NODE_API_MODULE(win32_drop_target, Init)
