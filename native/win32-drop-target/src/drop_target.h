#ifndef DROP_TARGET_H
#define DROP_TARGET_H

#include <napi.h>
#include <windows.h>
#include <oleidl.h>
#include <shellapi.h>
#include <string>
#include <vector>
#include <algorithm>
#include <cctype>
#include <cwctype>

/**
 * Custom Win32 COM IDropTarget implementation that intercepts OS file drops
 * before Chromium's broken handler (broken since Chromium v119 / Electron 28+).
 *
 * Extracts file paths from the OLE IDataObject via DragQueryFile() and forwards
 * them to JavaScript via Napi::ThreadSafeFunction callbacks.
 */
class CustomDropTarget : public IDropTarget {
public:
    CustomDropTarget(
        Napi::ThreadSafeFunction onDragEnter,
        Napi::ThreadSafeFunction onDragOver,
        Napi::ThreadSafeFunction onDragLeave,
        Napi::ThreadSafeFunction onDrop
    );

    // IUnknown methods
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;

    // IDropTarget methods
    HRESULT STDMETHODCALLTYPE DragEnter(
        IDataObject* pDataObj, DWORD grfKeyState,
        POINTL pt, DWORD* pdwEffect) override;

    HRESULT STDMETHODCALLTYPE DragOver(
        DWORD grfKeyState, POINTL pt, DWORD* pdwEffect) override;

    HRESULT STDMETHODCALLTYPE DragLeave() override;

    HRESULT STDMETHODCALLTYPE Drop(
        IDataObject* pDataObj, DWORD grfKeyState,
        POINTL pt, DWORD* pdwEffect) override;

    /** Release the ThreadSafeFunction instances (call before destructor). */
    void ReleaseCallbacks();

private:
    LONG refCount_;
    bool hasFiles_;  // Whether the current drag has CF_HDROP data

    Napi::ThreadSafeFunction onDragEnterTsfn_;
    Napi::ThreadSafeFunction onDragOverTsfn_;
    Napi::ThreadSafeFunction onDragLeaveTsfn_;
    Napi::ThreadSafeFunction onDropTsfn_;

    /** Image extensions for classification (all lowercase, with dot). */
    static bool IsImageExtension(const std::wstring& extension);

    /** Extract lowercase file extension from a path. */
    static std::wstring GetLowerExtension(const std::wstring& filePath);

    /** Convert a wide string to UTF-8. */
    static std::string WideToUtf8(const std::wstring& wide);
};

#endif // DROP_TARGET_H
