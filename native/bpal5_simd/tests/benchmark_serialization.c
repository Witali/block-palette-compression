#include "bpal5.h"

#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int main(int argc, char **argv) {
    bpal5_image image;
    unsigned long iterations = 200u;
    unsigned long iteration;
    uint64_t checksum = 0u;
    clock_t started;
    clock_t finished;
    char error[512];

    if (argc < 2 || argc > 3) {
        fprintf(stderr, "Usage: bpal5_serialize_benchmark input.bpal [iterations]\n");
        return 2;
    }
    if (argc == 3) {
        char *end = NULL;
        iterations = strtoul(argv[2], &end, 10);
        if (argv[2][0] == '\0' || end == NULL || *end != '\0' || iterations == 0u) {
            fprintf(stderr, "Invalid iteration count\n");
            return 2;
        }
    }

    if (!bpal5_load_file(argv[1], &image, error, sizeof(error))) {
        fprintf(stderr, "bpal5_serialize_benchmark: %s\n", error);
        return 1;
    }
    started = clock();
    for (iteration = 0u; iteration < iterations; ++iteration) {
        uint8_t *bytes = NULL;
        size_t byte_count = 0u;
        if (!bpal5_serialize(&image, &bytes, &byte_count, error, sizeof(error))) {
            fprintf(stderr, "bpal5_serialize_benchmark: %s\n", error);
            bpal5_image_free(&image);
            return 1;
        }
        checksum += bytes[byte_count / 2u];
        bpal5_free(bytes);
    }
    finished = clock();
    bpal5_image_free(&image);

    {
        const double total_milliseconds =
            (double)(finished - started) * 1000.0 / (double)CLOCKS_PER_SEC;
        printf(
            "%lu serializations: %.3f ms total, %.6f ms each, checksum %llu\n",
            iterations,
            total_milliseconds,
            total_milliseconds / (double)iterations,
            (unsigned long long)checksum
        );
    }
    return 0;
}
