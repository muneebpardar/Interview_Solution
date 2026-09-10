import React from 'react';
import { StatusBar } from 'expo-status-bar';
import ReportScreen from './src/screens/ReportScreen';

export default function App() {
  return (
    <>
      <StatusBar style="dark" />
      <ReportScreen />
    </>
  );
}
