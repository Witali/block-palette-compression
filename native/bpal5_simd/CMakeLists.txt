cmake_minimum_required(VERSION 3.20)
project(bpal5_simd VERSION 1.0 LANGUAGES C)

include(CTest)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_library(bpal5 STATIC
    src/bpal5.c
    src/bpal5_simd.c
    src/ppm.c
)
target_include_directories(bpal5 PUBLIC include PRIVATE src)

if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(AMD64|amd64|x86_64|X86_64|x64)$")
    target_sources(bpal5 PRIVATE src/bpal5_simd_avx2.c)
    target_compile_definitions(bpal5 PRIVATE BPAL5_HAVE_AVX2_IMPL=1)
    if(MSVC)
        set_source_files_properties(src/bpal5_simd_avx2.c PROPERTIES COMPILE_OPTIONS "/arch:AVX2")
    else()
        set_source_files_properties(src/bpal5_simd_avx2.c PROPERTIES COMPILE_OPTIONS "-mavx2")
    endif()
endif()

if(MSVC)
    target_compile_options(bpal5 PRIVATE /W4 /permissive-)
else()
    target_compile_options(bpal5 PRIVATE -Wall -Wextra -Wpedantic)
    target_link_libraries(bpal5 PUBLIC m)
endif()

add_executable(bpal5enc src/bpal5enc.c)
target_include_directories(bpal5enc PRIVATE src)
target_link_libraries(bpal5enc PRIVATE bpal5)

add_executable(bpal5dec src/bpal5dec.c)
target_include_directories(bpal5dec PRIVATE src)
target_link_libraries(bpal5dec PRIVATE bpal5)

if(BUILD_TESTING)
    add_executable(bpal5_roundtrip_test tests/test_roundtrip.c)
    target_link_libraries(bpal5_roundtrip_test PRIVATE bpal5)
    add_test(NAME bpal5_roundtrip COMMAND bpal5_roundtrip_test)

    find_program(NODE_EXECUTABLE node)
    if(NODE_EXECUTABLE)
        add_test(
            NAME bpal5_javascript_compatibility
            COMMAND "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/verify-js-compat.js"
                "$<TARGET_FILE:bpal5enc>" "$<TARGET_FILE:bpal5dec>" "${CMAKE_CURRENT_SOURCE_DIR}/../.."
        )
    endif()
endif()
