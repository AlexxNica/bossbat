import Redlock from 'redlock';
import Redis from 'ioredis';
import humanInterval from 'human-interval';
import { compose } from 'throwback';

// We timeout jobs after 2 seconds:
const JOB_TTL = 2000;
const JOB_PREFIX = 'bossman:job';

export default class Bossman {
  constructor({ connection, prefix = JOB_PREFIX, ttl = JOB_TTL } = {}) {
    const DB_NUMBER = (this.connection && this.connection.db) || 0;

    this.prefix = prefix;
    this.ttl = ttl;

    this.client = new Redis(connection);
    this.subscriber = new Redis(connection);
    this.redlock = new Redlock([this.client], { retryCount: 0 });

    this.jobs = {};
    this.qas = [];

    this.subscriber.config('SET', 'notify-keyspace-events', 'Ex');

    // Subscribe to expiring keys on the jobs DB:
    this.subscriber.subscribe(`__keyevent@${DB_NUMBER}__:expired`);
    this.subscriber.on('message', (channel, message) => {
      // Check to make sure that the message is a job run request:
      if (!message.startsWith(`${this.prefix}:work:`)) return;

      const jobName = message.split(':').pop();

      // Attempt to perform the job. Only one worker will end up getting assigned the job thanks to
      // distributed locking via redlock.
      this.doWork(jobName);

      // Schedule the next run now that we have the lock. We do this in every instance because it's
      // just a simple set command, and is okay to run on top of eachother.
      if (this.jobs[jobName]) {
        this.scheduleRun(jobName, this.jobs[jobName].every);
      }
    });
  }

  getJobKey(name) {
    return `${this.prefix}:work:${name}`;
  }

  getLockKey(name) {
    return `${this.prefix}:lock:${name}`;
  }

  hire(name, definition) {
    this.jobs[name] = definition;
    this.scheduleRun(name, definition.every);
  }

  doWork(name) {
    this.redlock.lock(this.getLockKey(name), this.ttl).then((lock) => {
      const fn = compose(this.qas);
      const response = fn(name, this.jobs[name], (jobName, definition) => (
        definition.work()
      ));

      const end = () => { lock.unlock(); };

      response.then(end, end);
    }, () => (
      // If we fail to get a lock, that means another instance already processed the job.
      // We just ignore these cases:
      null
    ));
  }

  qa(fn) {
    this.qas.push(fn);
  }

  scheduleRun(name, interval) {
    const timeout = humanInterval(interval);
    return this.client.set(this.getJobKey(name), name, 'PX', timeout, 'NX');
  }
}
