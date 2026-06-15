# Changelog v0.12.5

### [OPTIMIZED]
- **Multithreading**: Implemented `ThreadPoolExecutor` (max_workers=4) in `run_preprocess.py` to process multiple `.ims` datasets in parallel, significantly improving CPU utilization and overall throughput.
- **Progress Bars**: Integrated `tqdm` into `2-image_processor.py` to display real-time progress bars for Z-slice loading and LOD exporting.
