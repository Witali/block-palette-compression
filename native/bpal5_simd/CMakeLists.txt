cmake_minimum_required(VERSION 3.20)
project(bpal5_simd VERSION 1.0 LANGUAGES C)

include(CTest)
include(CheckLanguage)
find_package(OpenMP)

option(BPAL5_BUILD_CUDA "Build the CUDA BPAL encoder when nvcc is available" ON)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_library(bpal5 STATIC
    src/bpal5.c
    src/bpal5_simd.c
    src/image_loader.c
    src/ppm.c
)
target_include_directories(bpal5 PUBLIC include PRIVATE src third_party/stb)
if(OpenMP_C_FOUND)
    target_link_libraries(bpal5 PUBLIC OpenMP::OpenMP_C)
    target_compile_definitions(bpal5 PRIVATE BPAL5_HAVE_OPENMP=1)
endif()

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

add_executable(bpal5_serialize_benchmark EXCLUDE_FROM_ALL tests/benchmark_serialization.c)
target_link_libraries(bpal5_serialize_benchmark PRIVATE bpal5)

if(BPAL5_BUILD_CUDA)
    check_language(CUDA)
    if(CMAKE_CUDA_COMPILER)
        enable_language(CUDA)

        add_library(bpal5_cuda STATIC src/bpal5_cuda.cu)
        target_include_directories(bpal5_cuda PUBLIC include PRIVATE src)
        target_link_libraries(bpal5_cuda PUBLIC bpal5)
        set_target_properties(bpal5_cuda PROPERTIES
            CUDA_STANDARD 17
            CUDA_STANDARD_REQUIRED ON
            CUDA_RUNTIME_LIBRARY Static
        )

        add_executable(bpal5cudaenc src/bpal5cudaenc.cu)
        target_include_directories(bpal5cudaenc PRIVATE src)
        target_link_libraries(bpal5cudaenc PRIVATE bpal5_cuda)
        set_target_properties(bpal5cudaenc PROPERTIES
            CUDA_STANDARD 17
            CUDA_STANDARD_REQUIRED ON
            CUDA_RUNTIME_LIBRARY Static
        )
    else()
        message(STATUS "CUDA compiler not found; bpal5cudaenc will not be built")
    endif()
endif()

if(BUILD_TESTING)
    add_executable(bpal5_roundtrip_test tests/test_roundtrip.c)
    target_link_libraries(bpal5_roundtrip_test PRIVATE bpal5)
    add_test(NAME bpal5_roundtrip COMMAND bpal5_roundtrip_test)

    add_executable(bpal5_image_loader_test tests/test_image_loader.c)
    target_include_directories(bpal5_image_loader_test PRIVATE src)
    target_link_libraries(bpal5_image_loader_test PRIVATE bpal5)
    add_test(
        NAME bpal5_image_loader
        COMMAND bpal5_image_loader_test
            "${CMAKE_CURRENT_SOURCE_DIR}/../../assets/stone-texture-small.jpg"
            "${CMAKE_CURRENT_SOURCE_DIR}/../../assets/icons/app-icon-192.png"
    )

    if(TARGET bpal5_cuda)
        add_executable(bpal5_cuda_roundtrip_test tests/test_cuda_roundtrip.cu)
        target_link_libraries(bpal5_cuda_roundtrip_test PRIVATE bpal5_cuda)
        set_target_properties(bpal5_cuda_roundtrip_test PROPERTIES
            CUDA_STANDARD 17
            CUDA_STANDARD_REQUIRED ON
            CUDA_RUNTIME_LIBRARY Static
        )
        add_test(NAME bpal5_cuda_roundtrip COMMAND bpal5_cuda_roundtrip_test)
        set_tests_properties(bpal5_cuda_roundtrip PROPERTIES SKIP_RETURN_CODE 77 LABELS CUDA)
    endif()

    find_program(NODE_EXECUTABLE node)
    if(NODE_EXECUTABLE)
        add_test(
            NAME bpal5_javascript_compatibility
            COMMAND "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/verify-js-compat.js"
                "$<TARGET_FILE:bpal5enc>" "$<TARGET_FILE:bpal5dec>" "${CMAKE_CURRENT_SOURCE_DIR}/../.."
        )
    endif()
endif()
