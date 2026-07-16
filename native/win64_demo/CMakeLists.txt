cmake_minimum_required(VERSION 3.24)

project(block_texture_win64_demo VERSION 1.0 LANGUAGES C CXX)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "This demo must be configured for 64-bit Windows")
endif()

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(REPOSITORY_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../..")
set(BPAL_ROOT "${REPOSITORY_ROOT}/native/bpal5_simd")

include(CTest)

add_library(texture_codecs STATIC
    src/texture_loader.cpp
    src/shader_texture.cpp
    src/shader_texture_bpdh.cpp
    src/bplm_decoder.cpp
    src/dctbs2_decoder.cpp
    src/bpdh_decoder.cpp
    "${BPAL_ROOT}/src/bpal5.c"
    "${BPAL_ROOT}/src/bpal5_simd.c"
)
target_include_directories(texture_codecs
    PUBLIC src
    PRIVATE "${BPAL_ROOT}/include" "${BPAL_ROOT}/src"
)
target_link_libraries(texture_codecs PUBLIC windowscodecs ole32)
target_compile_definitions(texture_codecs PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)

if(MSVC)
    target_compile_options(texture_codecs PRIVATE /W4 /permissive- /utf-8)
endif()

if(BUILD_TESTING)
    add_executable(shader_texture_tests tests/shader_texture_tests.cpp)
    target_link_libraries(shader_texture_tests PRIVATE texture_codecs)
    target_compile_definitions(shader_texture_tests PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
    if(MSVC)
        target_compile_options(shader_texture_tests PRIVATE /W4 /permissive- /utf-8)
    endif()
    add_test(
        NAME shader_texture_tests
        COMMAND shader_texture_tests "${REPOSITORY_ROOT}"
    )
endif()

add_executable(block_texture_demo WIN32
    src/main.cpp
    src/texture_shader.hlsl
    src/app.manifest
)
set_source_files_properties(src/texture_shader.hlsl PROPERTIES HEADER_FILE_ONLY TRUE)

find_program(FXC_EXECUTABLE NAMES fxc.exe fxc REQUIRED)
set(SHADER_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/src/texture_shader.hlsl")
set(SHADER_OUTPUT_DIR "${CMAKE_CURRENT_BINARY_DIR}/shaders")
set(SHADER_VS "${SHADER_OUTPUT_DIR}/texture_vs.cso")
set(SHADER_BPAL_PS "${SHADER_OUTPUT_DIR}/texture_bpal_ps.cso")
set(SHADER_DCT_PS "${SHADER_OUTPUT_DIR}/texture_dct_ps.cso")
set(SHADER_BPDH_PS "${SHADER_OUTPUT_DIR}/texture_bpdh_ps.cso")
add_custom_command(
    OUTPUT "${SHADER_VS}" "${SHADER_BPAL_PS}" "${SHADER_DCT_PS}" "${SHADER_BPDH_PS}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${SHADER_OUTPUT_DIR}"
    COMMAND "${FXC_EXECUTABLE}" /nologo /O3 /T vs_5_1 /E VSMain /Fo "${SHADER_VS}" "${SHADER_SOURCE}"
    COMMAND "${FXC_EXECUTABLE}" /nologo /O3 /T ps_5_1 /E PSBpal /Fo "${SHADER_BPAL_PS}" "${SHADER_SOURCE}"
    COMMAND "${FXC_EXECUTABLE}" /nologo /O3 /T ps_5_1 /E PSDct /Fo "${SHADER_DCT_PS}" "${SHADER_SOURCE}"
    COMMAND "${FXC_EXECUTABLE}" /nologo /O3 /T ps_5_1 /E PSBpdh /Fo "${SHADER_BPDH_PS}" "${SHADER_SOURCE}"
    DEPENDS "${SHADER_SOURCE}"
    VERBATIM
)
add_custom_target(texture_shaders ALL
    DEPENDS "${SHADER_VS}" "${SHADER_BPAL_PS}" "${SHADER_DCT_PS}" "${SHADER_BPDH_PS}"
)
add_custom_target(deploy_texture_shaders ALL
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${SHADER_VS}"
        "${SHADER_BPAL_PS}" "${SHADER_DCT_PS}" "${SHADER_BPDH_PS}"
        "$<TARGET_FILE_DIR:block_texture_demo>"
    DEPENDS "${SHADER_VS}" "${SHADER_BPAL_PS}" "${SHADER_DCT_PS}" "${SHADER_BPDH_PS}"
)
add_dependencies(block_texture_demo deploy_texture_shaders)
target_link_libraries(block_texture_demo PRIVATE
    texture_codecs
    d3d12
    dxgi
    comdlg32
    shell32
)
target_compile_definitions(block_texture_demo PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
if(MSVC)
    target_compile_options(block_texture_demo PRIVATE /W4 /permissive- /utf-8)
    target_link_options(block_texture_demo PRIVATE /SUBSYSTEM:WINDOWS)
endif()

set(DEMO_ASSETS
    "${REPOSITORY_ROOT}/assets/bpal/stone-texture-wic-2.38bpp.bpal"
    "${REPOSITORY_ROOT}/assets/bpal/stone-texture-wic.bplm"
    "${REPOSITORY_ROOT}/assets/dct/stone-texture-wic-1.5bpp.dctbs2"
    "${REPOSITORY_ROOT}/assets/bpdh/landscape-alaska.bpdh"
)
add_custom_command(TARGET block_texture_demo POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E make_directory "$<TARGET_FILE_DIR:block_texture_demo>/assets"
)
foreach(ASSET IN LISTS DEMO_ASSETS)
    add_custom_command(TARGET block_texture_demo POST_BUILD
        COMMAND "${CMAKE_COMMAND}" -E copy_if_different
            "${ASSET}"
            "$<TARGET_FILE_DIR:block_texture_demo>/assets/"
    )
endforeach()
if(BUILD_TESTING)
    add_executable(texture_codec_tests tests/codec_tests.cpp)
    target_link_libraries(texture_codec_tests PRIVATE texture_codecs)
    target_compile_definitions(texture_codec_tests PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
    if(MSVC)
        target_compile_options(texture_codec_tests PRIVATE /W4 /permissive- /utf-8)
    endif()
    add_test(
        NAME texture_codec_tests
        COMMAND texture_codec_tests "${REPOSITORY_ROOT}"
    )
endif()
