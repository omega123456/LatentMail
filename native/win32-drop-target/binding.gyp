{
  "targets": [
    {
      "target_name": "win32_drop_target",
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/drop_target.cpp"],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "libraries": [
            "ole32.lib",
            "shell32.lib",
            "comctl32.lib"
          ],
          "defines": [
            "NAPI_VERSION=8",
            "NAPI_DISABLE_CPP_EXCEPTIONS"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1
            }
          }
        }]
      ]
    }
  ]
}
