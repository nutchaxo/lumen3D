
import sys, os, gzip
fpath = r'd:\Kristof\Morgan\OUTPUT\26.04.10-11.06\SAMPLE-1\SAMPLE-1.imaris_track'
with gzip.open(fpath, 'rb') as f:
    chunk = f.read(1024 * 1024 * 10) # read 10MB chunk to estimate compression ratio
    print('10MB decompressed...')
total_size = 0
with gzip.open(fpath, 'rb') as f:
    while True:
        buf = f.read(1024 * 1024 * 16)
        if not buf:
            break
        total_size += len(buf)
print('Total Uncompressed MB:', total_size / 1024 / 1024)

