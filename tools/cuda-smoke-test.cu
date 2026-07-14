#include <cuda_runtime.h>

#include <cstdio>

__global__ void increment(int *value) {
    *value += 1;
}

int main() {
    int host_value = 41;
    int *device_value = nullptr;
    cudaDeviceProp properties{};

    if (cudaGetDeviceProperties(&properties, 0) != cudaSuccess ||
        cudaMalloc(&device_value, sizeof(host_value)) != cudaSuccess ||
        cudaMemcpy(device_value, &host_value, sizeof(host_value), cudaMemcpyHostToDevice) != cudaSuccess) {
        std::fprintf(stderr, "CUDA setup failed: %s\n", cudaGetErrorString(cudaGetLastError()));
        return 1;
    }

    increment<<<1, 1>>>(device_value);
    if (cudaDeviceSynchronize() != cudaSuccess ||
        cudaMemcpy(&host_value, device_value, sizeof(host_value), cudaMemcpyDeviceToHost) != cudaSuccess) {
        std::fprintf(stderr, "CUDA kernel failed: %s\n", cudaGetErrorString(cudaGetLastError()));
        cudaFree(device_value);
        return 1;
    }

    cudaFree(device_value);
    std::printf("CUDA smoke test passed on %s: value=%d\n", properties.name, host_value);
    return host_value == 42 ? 0 : 1;
}
