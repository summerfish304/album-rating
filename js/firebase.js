import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs,
  query, where, deleteDoc, serverTimestamp, addDoc, updateDoc,
  onSnapshot, enableIndexedDbPersistence, orderBy, limit as fbLimit,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from './config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Оффлайн-режим: кэширование Firestore в IndexedDB
enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === "failed-precondition") {
    console.warn("Оффлайн-режим не активирован: открыто несколько вкладок");
  } else if (err.code === "unimplemented") {
    console.warn("Оффлайн-режим не поддерживается браузером");
  }
});

// Реэкспорт Firebase-функций, чтобы main.js мог их импортировать
export {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged,
  collection, doc, setDoc, getDoc, getDocs,
  query, where, deleteDoc, serverTimestamp, addDoc, updateDoc,
  onSnapshot, orderBy, fbLimit, writeBatch
};