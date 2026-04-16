import { v4 as uuid } from "uuid";
import EventEmitter from "events";

export default class JobList {
  #jobs = new Map();
  #eventEmitter = new EventEmitter();

  on(event, listener) {
    this.#eventEmitter.on(event, listener);
  }

  getJobs() {
    return this.#jobs;
  }

  createJob(data) {
    const id = uuid();
    const job = { id, created: new Date(), status: "queued", data };
    this.#jobs.set(id, job);
    this.#emit("job created", job);
    return job;
  }

  updateJobData(id, data) {
    const job = this.#jobs.get(id);
    job.data = data;
    this.#emit("job updated", job);
  }

  setJobInProgress(id) {
    const job = this.#jobs.get(id);
    job.status = "in_progress";
    this.#emit("job updated", job);
  }

  setJobFinished(id) {
    const job = this.#jobs.get(id);
    job.status = "finished";
    this.#emit("job updated", job);
  }

  setJobFailed(id, error) {
    const job = this.#jobs.get(id);
    job.status = "failed";
    job.error = error;
    this.#emit("job updated", job);
  }

  #emit(event, job) {
    this.#eventEmitter.emit(event, { job, jobs: Array.from(this.#jobs.values()) });
  }
}
