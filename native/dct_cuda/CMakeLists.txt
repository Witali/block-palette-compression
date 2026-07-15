cmake_minimum_required(VERSION 3.24)

project(dctcuda LANGUAGES CXX CUDA)

add_executable(dctcuda dctcuda.cu)
target_include_directories(
  dctcuda
  PRIVATE
    ../bpal5_simd/third_party/stb
)
target_compile_features(dctcuda PRIVATE cxx_std_17 cuda_std_17)

if(NOT DEFINED CMAKE_CUDA_ARCHITECTURES)
  set_property(TARGET dctcuda PROPERTY CUDA_ARCHITECTURES native)
endif()

if(MSVC)
  target_compile_options(dctcuda PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:-O3>)
else()
  target_compile_options(dctcuda PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:-O3>)
endif()

set_target_properties(
  dctcuda
  PROPERTIES
    CUDA_SEPARABLE_COMPILATION OFF
    CUDA_RESOLVE_DEVICE_SYMBOLS OFF
)
